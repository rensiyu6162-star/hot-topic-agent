import { NextRequest } from "next/server";
import { kvConfigured } from "./kv-config";
import type { LlmOverride } from "./llm-providers";

// scheduler.ts 被 API routes 正常静态 import → Next.js 正常编译 → 进 .next/server/lib/scheduler.js
// kv.js 是纯 CommonJS，通过 eval("require") + 绝对路径加载（绕开 Next.js 编译管线）
let _kvFn: any = null;
function getKvFn() {
  if (!_kvFn) {
    // eslint-disable-next-line no-eval
    const _require = eval("require");
    _kvFn = _require(
      _require("path").join(process.cwd(), "src", "server", "kv.js")
    ).kv;
  }
  return _kvFn;
}
async function kv(...args: any[]): Promise<any> {
  return getKvFn()(...args);
}

// ===== 定时任务（服务端）=====
// 以「同步码」为身份：调度配置存在 KV 的 sched:<code>，抓取结果写回 sync:<code> 的专属会话。
// 到点由进程内定时器(instrumentation.ts)每分钟调用 runDueSchedules() 驱动——
// VPS 上的 Docker 是常驻进程，关掉浏览器也能跑；Vercel 无常驻定时器，实际以 VPS 为准。
//
// Key 策略（强制 BYOK）：定时任务到点无人值守、用不了浏览器 localStorage 里的 Key，
// 因此创建任务时必须把创建者【自己的 Key】随快照存入 sched:<code>，到点用它跑——
// 服务端系统 Key 绝不为匿名访客的定时任务兜底。

export interface ScheduleSnapshot {
  domain: string; // 锁定领域串（空=全部）
  platforms: string[];
  glossary: Record<string, string>;
  allDomains: string[];
  // 创建者自带的模型配置（apiKey 必填）；仅存于 sched:<code>，不进 sync 同步载荷
  llm?: LlmOverride | null;
}
export interface ScheduleConfig {
  enabled: boolean;
  everyDays: number; // 每 X 天，1~30
  times: string[]; // HH:MM，最多 3 个
  anchor: string; // 起算日 = 开始日期 YYYY-MM-DD（CST），也是「每 X 天」的对齐基准
  endDate: string; // 结束日期 YYYY-MM-DD（CST）；空串=不设结束，一直执行
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
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  // 开始日期：合法则采用，否则默认今天（CST）
  const startDate =
    typeof input?.startDate === "string" && dateRe.test(input.startDate.trim())
      ? input.startDate.trim()
      : todayCst;
  // 结束日期：选填，空串=一直执行
  const endRaw = typeof input?.endDate === "string" ? input.endDate.trim() : "";
  const endDate = dateRe.test(endRaw) ? endRaw : "";
  if (endDate && endDate < startDate) {
    return { error: "结束日期不能早于开始日期" };
  }
  const s = input?.snapshot || {};
  // 创建者自带的模型配置（强制 BYOK）：apiKey 必填，缺失则拒绝创建——
  // 到点无人值守时用这份 Key 抓取，绝不用服务端系统 Key 为匿名访客付费。
  const rawLlm = s?.llm;
  const llm: LlmOverride | null =
    rawLlm &&
    typeof rawLlm === "object" &&
    typeof rawLlm.apiKey === "string" &&
    rawLlm.apiKey.trim()
      ? {
          provider:
            typeof rawLlm.provider === "string" ? rawLlm.provider : "deepseek",
          apiKey: rawLlm.apiKey.trim(),
          ...(typeof rawLlm.baseUrl === "string" && rawLlm.baseUrl.trim()
            ? { baseUrl: rawLlm.baseUrl.trim() }
            : {}),
          ...(typeof rawLlm.model === "string" && rawLlm.model.trim()
            ? { model: rawLlm.model.trim() }
            : {}),
        }
      : null;
  if (!llm) {
    return {
      error:
        "定时任务需要先配置你自己的 API Key：打开「🤖 AI 模型」填好并保存后再创建（到点自动抓取时用的是你自己的 Key）。",
    };
  }
  const snapshot: ScheduleSnapshot = {
    domain: typeof s.domain === "string" ? s.domain : "",
    platforms: Array.isArray(s.platforms) ? s.platforms : [],
    glossary: s.glossary && typeof s.glossary === "object" ? s.glossary : {},
    allDomains: Array.isArray(s.allDomains) ? s.allDomains : [],
    llm,
  };
  return {
    enabled: input?.enabled !== false,
    everyDays,
    times,
    anchor: startDate,
    endDate,
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
      // 用创建者创建任务时保存的自带 Key（强制 BYOK，不花系统 Key）
      llm: snapshot.llm ?? null,
    }),
  });

  let content = "";
  let toolLogs: string[] = [];
  let emptyNote: string | null = null;
  let refs: any = null;
  try {
    const res = await chatPOST(chatReq);
    const data = await res.json();
    content = data?.content || "（本次未获取到内容）";
    toolLogs = Array.isArray(data?.toolLogs) ? data.toolLogs : [];
    emptyNote = data?.emptyNote || null;
    // 定时抓取若走了全网搜索补挂/兜底，参考来源同样挂到第一层回复（前端按 refs 渲染折叠块）
    if (
      data?.refs &&
      typeof data.refs === "object" &&
      (Array.isArray(data.refs.sites) || Array.isArray(data.refs.videos))
    ) {
      refs = data.refs;
    }
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
  if (refs) assistantMsg.refs = refs;
  sess.messages.push(assistantMsg);

  // 限制专属会话消息数，防止无限增长（保留最近 200 条 + 欢迎语）
  if (sess.messages.length > 201) {
    const welcome = sess.messages[0];
    sess.messages = [welcome, ...sess.messages.slice(-200)];
  }

  // 成功的抓取结果自动沉淀到本地 RAG 知识库，供日后"历史回溯/复盘"类提问检索。
  // 失败、空结果不入库；ingest 内部静默失败，绝不影响同步主流程。
  if (!content.startsWith("⚠️") && content !== "（本次未获取到内容）" && !emptyNote) {
    try {
      const { ingestHotDocs } = await import("@/lib/rag-ingest");
      await ingestHotDocs([
        {
          title: `${stamp} 热点抓取${snapshot.domain ? "·" + snapshot.domain : ""}`,
          body: content,
          category: snapshot.domain || undefined,
          platforms: Array.isArray(snapshot.platforms) ? snapshot.platforms : undefined,
          date: stamp.slice(0, 10),
          docId: `sched:${code}:${slotKey}`,
        },
      ]);
    } catch {}
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
// 进程内互斥（2026-09）：instrumentation 的每分钟定时器与 /api/schedule/tick（外部 cron 兜底）
// 可能同时触发本函数。单次 runFetch 内含完整 chat 抓取、要跑几十秒，而 fired 槽位是
// "跑完才写"——并发双触发会对同一槽位各跑一次（重复抓取+重复消息），且两次对 sync:<code>
// 的读-改-写互相覆盖会丢消息。VPS 上是单 Docker 单进程，一个布尔互斥即可根治。
const schedGlobals = globalThis as unknown as { __HT_SCHED_RUNNING__?: boolean };
export async function runDueSchedules(nowMs: number = Date.now()): Promise<void> {
  if (schedGlobals.__HT_SCHED_RUNNING__) return;
  schedGlobals.__HT_SCHED_RUNNING__ = true;
  try {
    await runDueSchedulesInner(nowMs);
  } finally {
    schedGlobals.__HT_SCHED_RUNNING__ = false;
  }
}

async function runDueSchedulesInner(nowMs: number): Promise<void> {
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

    // 超过结束日期（若设置了）→ 跳过
    if (cfg.endDate && dateStr > cfg.endDate) continue;

    // 是否为「每 X 天」的当天（diff<0 表示还没到开始日期）
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
