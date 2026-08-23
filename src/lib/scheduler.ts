import { NextRequest } from "next/server";
import { kv, kvConfigured } from "./kv";

// ===== 定时任务（服务端）=====
// 以「同步码」为身份：调度配置存在 KV 的 sched:<code>，抓取结果写回 sync:<code> 的专属会话。
// 到点由进程内定时器(instrumentation.ts)每分钟调用 runDueSchedules() 驱动——
// VPS 上的 Docker 是常驻进程，关掉浏览器也能跑；Vercel 无常驻定时器，实际以 VPS 为准。

export interface ScheduleSnapshot {
  domain: string; // 锁定领域串（空=全部）
  platforms: string[];
  glossary: Record<string, string>;
  allDomains: string[];
}
export interface ScheduleConfig {
  enabled: boolean;
  everyDays: number; // 每 X 天，1~30
  times: string[]; // HH:MM，最多 3 个
  anchor: string; // 起算日 YYYY-MM-DD（CST）
  snapshot: ScheduleSnapshot;
  fired: string[]; // 已触发的槽位键 `${dateStr}T${HH:MM}`，仅保留最近若干条
  updatedAt: number;
}

const SCHED_KEY = (code: string) => `sched:${code}`;
const SYNC_KEY = (code: string) => `sync:${code}`;
const INDEX_KEY = "sched:index";
const TTL = 60 * 60 * 24 * 90; // 90 天
const CATCHUP_MIN = 10; // 到点后 10 分钟内仍可补跑（容忍 tick 抖动/刚启动）
const SCHED_SESSION_ID = "scheduled";
const WELCOME_TEXT =
  "⏰ 这是定时任务专属会话，按你配置的频率自动抓取今日热点，结果会追加在下面。";

// UTC 毫秒 → 北京时间(CST, UTC+8) 的日期/时刻分量
function cstParts(nowMs: number) {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function parseHM(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function daysBetween(anchor: string, today: string): number {
  const a = Date.parse(`${anchor}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (isNaN(a) || isNaN(t)) return -1;
  return Math.round((t - a) / 86400000);
}

// ===== 配置读写 =====
export async function getSchedule(code: string): Promise<ScheduleConfig | null> {
  if (!kvConfigured()) return null;
  const raw = await kv(["GET", SCHED_KEY(code)]);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ScheduleConfig;
  } catch {
    return null;
  }
}

export async function saveSchedule(
  code: string,
  cfg: ScheduleConfig
): Promise<void> {
  await kv(["SET", SCHED_KEY(code), JSON.stringify(cfg), "EX", TTL]);
  await kv(["SADD", INDEX_KEY, code]);
}

export async function deleteSchedule(code: string): Promise<void> {
  await kv(["DEL", SCHED_KEY(code)]);
  await kv(["SREM", INDEX_KEY, code]);
}

// 规范化客户端传来的配置（防脏数据）
export function normalizeConfig(
  input: any,
  todayCst: string
): ScheduleConfig | { error: string } {
  const everyDays = Math.round(Number(input?.everyDays));
  if (!(everyDays >= 1 && everyDays <= 30)) return { error: "频率需为 1~30 天" };
  const rawTimes = Array.isArray(input?.times) ? input.times : [];
  const times = Array.from(
    new Set(
      rawTimes
        .map((t: any) => (typeof t === "string" ? t.trim() : ""))
        .filter((t: string) => parseHM(t) !== null)
    )
  ).slice(0, 3) as string[];
  if (times.length === 0) return { error: "至少配置一个触发时间" };
  const s = input?.snapshot || {};
  const snapshot: ScheduleSnapshot = {
    domain: typeof s.domain === "string" ? s.domain : "",
    platforms: Array.isArray(s.platforms) ? s.platforms : [],
    glossary: s.glossary && typeof s.glossary === "object" ? s.glossary : {},
    allDomains: Array.isArray(s.allDomains) ? s.allDomains : [],
  };
  return {
    enabled: input?.enabled !== false,
    everyDays,
    times,
    anchor: todayCst,
    snapshot,
    fired: [],
    updatedAt: Date.now(),
  };
}

export function cstToday(nowMs: number = Date.now()): string {
  return cstParts(nowMs).dateStr;
}

// ===== 执行 =====
// 调 chat 路由（进程内），把结果追加进 sync:<code> 的专属会话
async function runFetch(
  code: string,
  cfg: ScheduleConfig,
  slotKey: string
): Promise<void> {
  const { snapshot } = cfg;
  // 动态引入，避免 instrumentation 早期加载时的循环依赖
  const { POST: chatPOST } = await import("@/app/api/chat/route");

  const userText = "帮我抓取今日热点";
  const chatReq = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: userText }],
      domain: snapshot.domain,
      platforms: snapshot.platforms,
      glossary: snapshot.glossary,
      allDomains: snapshot.allDomains,
    }),
  });

  let content = "";
  let toolLogs: string[] = [];
  let emptyNote: string | null = null;
  try {
    const res = await chatPOST(chatReq);
    const data = await res.json();
    content = data?.content || "（本次未获取到内容）";
    toolLogs = Array.isArray(data?.toolLogs) ? data.toolLogs : [];
    emptyNote = data?.emptyNote || null;
  } catch (e: any) {
    content = `⚠️ 定时抓取失败：${e?.message || e}`;
  }

  // 读取现有 sync payload，追加到专属会话
  let payload: any = {};
  try {
    const raw = await kv(["GET", SYNC_KEY(code)]);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      payload = parsed?.payload || {};
    }
  } catch {
    payload = {};
  }
  if (!Array.isArray(payload.sessions)) payload.sessions = [];

  let sess = payload.sessions.find((x: any) => x?.id === SCHED_SESSION_ID);
  if (!sess) {
    sess = {
      id: SCHED_SESSION_ID,
      title: "⏰ 定时任务",
      messages: [{ role: "assistant", content: WELCOME_TEXT }],
    };
    payload.sessions.unshift(sess);
  }
  if (!Array.isArray(sess.messages)) sess.messages = [];

  const stamp = slotKey.replace("T", " ");
  sess.messages.push({ role: "user", content: `[${stamp}] ${userText}` });
  const assistantMsg: any = { role: "assistant", content, toolLogs };
  if (emptyNote) assistantMsg.emptyNote = emptyNote;
  sess.messages.push(assistantMsg);

  // 限制专属会话消息数，防止无限增长（保留最近 200 条 + 欢迎语）
  if (sess.messages.length > 201) {
    const welcome = sess.messages[0];
    sess.messages = [welcome, ...sess.messages.slice(-200)];
  }

  await kv([
    "SET",
    SYNC_KEY(code),
    JSON.stringify({ payload, updatedAt: Date.now() }),
    "EX",
    TTL,
  ]);
}

// 每分钟由 instrumentation 定时器调用：扫描所有配置，跑到点的槽位
export async function runDueSchedules(nowMs: number = Date.now()): Promise<void> {
  if (!kvConfigured()) return;
  let codes: string[] = [];
  try {
    codes = (await kv(["SMEMBERS", INDEX_KEY])) || [];
  } catch {
    return;
  }
  if (!Array.isArray(codes) || codes.length === 0) return;

  const { dateStr, minutesOfDay } = cstParts(nowMs);

  for (const code of codes) {
    let cfg: ScheduleConfig | null = null;
    try {
      cfg = await getSchedule(code);
    } catch {
      cfg = null;
    }
    if (!cfg) {
      // 配置已不存在，清理索引
      try {
        await kv(["SREM", INDEX_KEY, code]);
      } catch {}
      continue;
    }
    if (!cfg.enabled) continue;

    // 是否为「每 X 天」的当天
    const diff = daysBetween(cfg.anchor, dateStr);
    if (diff < 0 || diff % cfg.everyDays !== 0) continue;

    let changed = false;
    for (const t of cfg.times) {
      const target = parseHM(t);
      if (target == null) continue;
      // 到点后 CATCHUP_MIN 分钟内可补跑
      const delta = minutesOfDay - target;
      if (delta < 0 || delta > CATCHUP_MIN) continue;

      const slotKey = `${dateStr}T${t}`;
      if (cfg.fired.includes(slotKey)) continue;

      try {
        await runFetch(code, cfg, slotKey);
        cfg.fired.push(slotKey);
        // 只保留最近 30 个槽位键
        if (cfg.fired.length > 30) cfg.fired = cfg.fired.slice(-30);
        changed = true;
      } catch {
        // 失败不写 fired，下一分钟仍在 catch-up 窗口内可重试
      }
    }
    if (changed) {
      cfg.updatedAt = Date.now();
      try {
        await saveSchedule(code, cfg);
      } catch {}
    }
  }
}
