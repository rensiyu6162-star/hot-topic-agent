// 意图分类器【语义层】真实模型黄金回归集 + 门禁（2026-09 补）。
//
// 跑法（容器内，依赖 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，与生产同源）：
//   node eval/grade-intent.mjs <intent.ts 路径>
//   例：docker exec hot-web node /tmp/eval/grade-intent.mjs /tmp/intent.ts
//
// 它和 tests/intent.test.ts 的分工：
//   · 单测（mock 分类器）守护的是 LLM 输出【之后】的确定性结构（逐字闸/跨主体闸/兜底/邮戳）；
//   · 本门禁守护的是 LLM 【本身】看到真实说法会不会判对——改 prompt、换模型版本后语义漂移，
//     只有真实调用能发现。
//
// 工作方式：
// 1. 从【生产源码 intent.ts】的 intent-classifier-prompt 标记之间正则抽取线上分类 prompt
//    模板原文（抽不到=生产结构已变，门禁拒绝运行），保证评测与线上严格同源；
// 2. 每条案例真实调用 deepseek-chat，temperature=0，逐条串行（避免限流导致集体失真）；
// 3. 考 intent 四类 + 结构题 mode（intro/followup）+ 关键槽位 subject/domains/qualifier；
// 4. 输出混淆矩阵、每类 P/R/F1、方向误判（非 hot 误判成 hot=热榜顶掉提问，最严重）、P95。
//
// 门禁线：解析失败=0；总准确率≥0.90；非hot→hot 方向误判=0；结构题 mode≥0.85；槽位≥0.90。
// LLM 判定存在波动，FAIL 先原样重跑一次，仍 FAIL 才阻断。
//
// 维护规矩：线上新发现的误判说法只追加真实案例、不改旧例；案例词只存在于本评测，
// 【禁止】搬进生产 prompt 当规则词表。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const KEY = process.env.OPENAI_API_KEY;
const BASE = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1").replace(
  /\/+$/,
  ""
);
const MODEL = process.env.OPENAI_MODEL || "deepseek-chat";
const SRC_PATH = process.argv[2] || "/tmp/intent.ts";

const MIN_ACC = 0.9;
const MIN_MODE = 0.85;
const MIN_SLOT = 0.9;

// 与生产 DEFAULT_DOMAINS 同源（系统内置 10 领域）
export const UNIVERSE = [
  "情感两性", "职场成长", "财经理财", "健康养生", "育儿教育",
  "社会热点", "历史文化", "影视娱乐", "科技互联网", "法制普法",
];

// 上一轮助手节选模板（配合 turn 使用）
const EX_HOTBOARD = "实时热榜 微博 知乎 B站 抖音……今日热点已按平台聚合：1. xxx 2. xxx";
const EX_ZONT = "【主体速览】zont1x，CS2 职业选手，年少成名，曾被下放，现效力于强队。";
const EX_FAKER = "【主体速览】Faker，本名李相赫，韩国 T1 战队中单选手，曾离开又回归。";
const EX_LFQ = "【主体速览】老番茄，B站游戏区UP主，阴阳怪气男团成员（某幻、花少北、中国boy、LexBurner、老番茄）。";
const EX_487 = "【主体速览】487 并非单一指称，常见的是①电竞选手 Wolves_487 何添顺②贴吧楼③老歌代号。";
const EX_EVENT = "【主体速览】某商场店员与顾客冲突事件：网传双方发生口角，当事人尚未公开回应。";
const EX_POLICY = "【主体速览】育儿补贴新政：多省对三孩家庭每月发放补贴，细则各地不同。";

// t=本轮原话；exp=期望 intent；turn/ex=上文结构与节选；mode/sub/domains/qualifier=可选槽位断言
export const CASES = [
  // ---------- hot：要今天的榜单数据 ----------
  { id: "hot-1", t: "帮我抓今日热点", exp: "hot" },
  { id: "hot-2", t: "今天有啥可写的？", exp: "hot" },
  { id: "hot-3", t: "帮我抓一下宠物和露营的热点", exp: "hot", domains: ["宠物", "露营"] },
  { id: "hot-4", t: "帮我抓取今日热点，关注一下量子计算突破", exp: "hot" },
  { id: "hot-5", t: "根据bl与bg大战领域筛选热点", exp: "hot", domains: ["bl与bg大战"] },
  { id: "hot-6", t: "拉一下今天微博热榜", exp: "hot" },
  { id: "hot-7", t: "今天各平台有什么热点选题", exp: "hot" },
  { id: "hot-8", t: "女权圈最近有什么大瓜可以写", exp: "hot", domains: ["女权"] },
  { id: "hot-9", t: "看看最近打工人圈有啥热闹", exp: "hot", domains: ["打工人"] },
  { id: "hot-10", t: "电竞的", exp: "hot", turn: "hotboard", ex: EX_HOTBOARD, domains: ["电竞"] },
  { id: "hot-11", t: "宠物的呢", exp: "hot", turn: "hotboard", ex: EX_HOTBOARD, domains: ["宠物"] },
  { id: "hot-12", t: "女性主义的", exp: "hot", turn: "hotboard", ex: EX_HOTBOARD, domains: ["女性主义"] },

  // ---------- chat：要判断/建议/分析 ----------
  { id: "chat-1", t: "村超最近好像很火，值得做内容吗", exp: "chat", sub: "村超" },
  { id: "chat-2", t: "你怎么看年轻人扎堆买金豆这件事", exp: "chat" },
  { id: "chat-3", t: "最近大瓜好多", exp: "chat" },
  { id: "chat-4", t: "这个热点该不该跟", exp: "chat", turn: "hotboard", ex: EX_HOTBOARD },
  { id: "chat-5", t: "育儿补贴新政要不要做一期", exp: "chat" },
  { id: "chat-6", t: "别抓热点了，就跟我聊聊村超到底值不值得做", exp: "chat", sub: "村超" },
  { id: "chat-7", t: "不用抓榜，跟我说说现在入局小红书还来得及吗", exp: "chat" },
  { id: "chat-8", t: "降息了，普通人手里的钱该往哪放", exp: "chat" },
  { id: "chat-9", t: "Faker这个人你怎么评价", exp: "chat", sub: "Faker" },
  { id: "chat-10", t: "选题卡在婆媳关系上写不下去，怎么办", exp: "chat" },

  // ---------- entity / intro：具体主体首次点名 ----------
  { id: "ent-1", t: "shiro", exp: "entity", mode: "intro", sub: "shiro" },
  { id: "ent-2", t: "zont1x是谁", exp: "entity", mode: "intro", sub: "zont1x" },
  { id: "ent-3", t: "破防是什么意思", exp: "entity", mode: "intro", sub: "破防" },
  { id: "ent-4", t: "花少北是谁", exp: "entity", mode: "intro", sub: "花少北", turn: "overview", ex: EX_LFQ },
  { id: "ent-5", t: "女性主义", exp: "entity", mode: "intro", sub: "女性主义", turn: "hotboard", ex: EX_HOTBOARD },
  { id: "ent-6", t: "露营", exp: "entity", mode: "intro", sub: "露营" },
  { id: "ent-7", t: "city不city是什么梗", exp: "entity", mode: "intro" },
  { id: "ent-8", t: "487", exp: "entity", mode: "intro", sub: "487" },
  { id: "ent-9", t: "电竞的", exp: "entity", mode: "intro", sub: "487", qualifier: "电竞", turn: "overview", ex: EX_487 },
  { id: "ent-10", t: "Cursor这个编辑器最近为什么突然火了", exp: "entity", mode: "intro", sub: "Cursor" },
  { id: "ent-11", t: "先别写稿了，花少北是谁", exp: "entity", mode: "intro", sub: "花少北", turn: "overview", ex: EX_LFQ },
  { id: "ent-12", t: "经典我一个bl妹都想反bl了是什么梗", exp: "entity", mode: "intro" },

  // ---------- entity / followup：代词追问上文同一主体 ----------
  { id: "fu-1", t: "他当时为什么被下放", exp: "entity", mode: "followup", sub: "zont1x", turn: "overview", ex: EX_ZONT },
  { id: "fu-2", t: "再讲讲他出道的经历", exp: "entity", mode: "followup", sub: "zont1x", turn: "overview", ex: EX_ZONT },
  { id: "fu-3", t: "那她后来道歉了吗", exp: "entity", mode: "followup", turn: "overview", ex: EX_EVENT },
  { id: "fu-4", t: "上面说的那个政策具体补多少钱", exp: "entity", mode: "followup", turn: "overview", ex: EX_POLICY },
  { id: "fu-5", t: "不用给我拉榜单，他当年为什么离开战队", exp: "entity", mode: "followup", sub: "Faker", turn: "overview", ex: EX_FAKER },
  { id: "fu-6", t: "这个人还有什么争议", exp: "entity", mode: "followup", sub: "zont1x", turn: "overview", ex: EX_ZONT },

  // ---------- task：产出/加工内容 ----------
  { id: "task-1", t: "zont1x年少成名、生涯坎坷的角度写口播稿", exp: "task" },
  { id: "task-2", t: "帮我把上面这段润色一下", exp: "task", turn: "other" },
  { id: "task-3", t: "用村超的素材来一篇三分钟短视频脚本", exp: "task" },
  { id: "task-4", t: "给这条新闻起五个标题", exp: "task" },
  { id: "task-5", t: "把这段文案缩写成30秒版本", exp: "task" },
  { id: "task-6", t: "帮我写一期育儿补贴的口播文案", exp: "task" },
];

function loadProductionPrompt() {
  const src = readFileSync(SRC_PATH, "utf8");
  const m = src.match(
    /intent-classifier-prompt-start \*\/\s*`([\s\S]*?)`;\s*\/\* intent-classifier-prompt-end/
  );
  if (!m)
    throw new Error(
      `未能从 ${SRC_PATH} 抽取 intent-classifier-prompt 模板（标记缺失/结构已变），门禁拒绝运行`
    );
  return new Function(
    "universe",
    "lastTurnType",
    "lastAssistantExcerpt",
    "lastUserContent",
    `"use strict"; return \`${m[1]}\`;`
  );
}

async function classifyOne(buildPrompt, c) {
  const started = Date.now();
  const prompt = buildPrompt(
    UNIVERSE,
    c.turn || "none",
    c.ex || "",
    c.t
  );
  const callOnce = async () => {
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });
    if (!r.ok) throw new Error("http_" + r.status);
    const raw = (await r.json()).choices?.[0]?.message?.content || "";
    const mm = raw.match(/\{[\s\S]*\}/);
    if (!mm) throw new Error("no-json:" + raw.slice(0, 80));
    return JSON.parse(mm[0]);
  };
  try {
    const obj = await callOnce();
    return { obj, ms: Date.now() - started, raw: "" };
  } catch (e) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const obj = await callOnce();
      return { obj, ms: Date.now() - started, raw: "" };
    } catch (e2) {
      return { obj: null, ms: Date.now() - started, raw: String(e2?.message || e2) };
    }
  }
}

function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, "");
}

// 仅在被 node 直接执行时跑门禁；被 import（如消融实验复用 CASES）时不开跑。
const isMain =
  !!process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain)
(async () => {
  if (!KEY) {
    console.error("缺少 OPENAI_API_KEY");
    process.exit(2);
  }
  const buildPrompt = loadProductionPrompt();

  const labels = ["hot", "chat", "entity", "task"];
  const matrix = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
  const rows = [];
  let parseFail = 0;
  let intentHit = 0;
  let modeTotal = 0, modeHit = 0;
  let slotTotal = 0, slotHit = 0;
  let dangerHot = 0; // 期望非 hot 却判 hot（热榜顶掉提问，最严重）
  const lats = [];

  for (const c of CASES) {
    const { obj, ms, raw } = await classifyOne(buildPrompt, c);
    lats.push(ms);
    if (!obj || typeof obj !== "object") {
      parseFail++;
      rows.push({ ...c, got: null, ok: false, raw });
      console.log(`✗ [${c.id}] 解析失败：${raw}`);
      continue;
    }
    const got = String(obj.intent || "");
    const ok = got === c.exp;
    if (ok) intentHit++;
    if (labels.includes(got)) matrix[c.exp][got]++;
    if (!ok && got === "hot") dangerHot++;

    // 结构题 mode
    let modeOk = null;
    if (c.mode) {
      modeTotal++;
      modeOk = String(obj.mode || "") === c.mode;
      if (modeOk) modeHit++;
    }
    // 槽位断言（subject/domains/qualifier）
    const slotErrs = [];
    if (c.sub) {
      slotTotal++;
      const hit = norm(obj.subject) === norm(c.sub) || norm(obj.subject).includes(norm(c.sub)) || norm(c.sub).includes(norm(obj.subject));
      if (hit) slotHit++; else slotErrs.push(`subject 期望「${c.sub}」实得「${obj.subject}」`);
    }
    if (c.domains) {
      slotTotal++;
      const gotD = Array.isArray(obj.domains) ? obj.domains.map((x) => norm(x)) : [];
      const all = c.domains.every((d) => gotD.includes(norm(d)));
      if (all) slotHit++; else slotErrs.push(`domains 期望[${c.domains.join(",")}]实得[${(obj.domains || []).join(",")}]`);
    }
    if (c.qualifier) {
      slotTotal++;
      if (norm(obj.qualifier) === norm(c.qualifier)) slotHit++;
      else slotErrs.push(`qualifier 期望「${c.qualifier}」实得「${obj.qualifier}」`);
    }

    rows.push({ id: c.id, t: c.t, exp: c.exp, got, ok, modeOk, slotErrs, ms });
    const flag = ok && modeOk !== false && slotErrs.length === 0 ? " " : "✗";
    const detail = [
      !ok ? `期望${c.exp}判${got}` : "",
      modeOk === false ? `mode期望${c.mode}实得${obj.mode}` : "",
      ...slotErrs,
    ].filter(Boolean).join("；");
    console.log(`${flag} [${c.id}] ${c.exp}→${got} ${c.t.slice(0, 26)}${detail ? " | " + detail : ""}${ms > 4000 ? " (" + ms + "ms)" : ""}`);
  }

  const n = CASES.length;
  const acc = intentHit / n;
  const modeAcc = modeTotal ? modeHit / modeTotal : 1;
  const slotAcc = slotTotal ? slotHit / slotTotal : 1;
  lats.sort((a, b) => a - b);
  const p95 = lats[Math.floor(lats.length * 0.95) - 1] || 0;

  console.log(`\n========== 混淆矩阵（行=期望 列=实判）==========`);
  console.log("        " + labels.map((l) => l.padStart(7)).join(""));
  for (const a of labels) {
    console.log(a.padEnd(7) + labels.map((b) => String(matrix[a][b]).padStart(7)).join(""));
  }
  console.log(`\n========== 每类 P/R/F1 ==========`);
  for (const a of labels) {
    const tp = matrix[a][a];
    const fp = labels.filter((b) => b !== a).reduce((s, b) => s + matrix[b][a], 0);
    const fn = labels.filter((b) => b !== a).reduce((s, b) => s + matrix[a][b], 0);
    const p = tp + fp ? tp / (tp + fp) : 1;
    const r = tp + fn ? tp / (tp + fn) : 1;
    const f = p + r ? (2 * p * r) / (p + r) : 0;
    console.log(`${a.padEnd(7)} P=${p.toFixed(2)} R=${r.toFixed(2)} F1=${f.toFixed(2)}（${tp}/${tp + fn}）`);
  }

  const pass =
    parseFail === 0 &&
    acc >= MIN_ACC &&
    dangerHot === 0 &&
    modeAcc >= MIN_MODE &&
    slotAcc >= MIN_SLOT;
  console.log(`\n========== 门禁结果 ==========`);
  console.log(
    `总准确率=${acc.toFixed(3)}（线${MIN_ACC}，${intentHit}/${n}）｜非hot→hot方向误判=${dangerHot}（线0）｜mode结构=${modeAcc.toFixed(3)}（线${MIN_MODE}，${modeHit}/${modeTotal}）｜槽位=${slotAcc.toFixed(3)}（线${MIN_SLOT}，${slotHit}/${slotTotal}）｜解析失败=${parseFail}｜P95=${(p95 / 1000).toFixed(1)}s`
  );
  console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");

  try {
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `grade-intent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model: MODEL, acc, dangerHot, modeAcc, slotAcc, parseFail, p95, pass, rows }, null, 2));
    console.log("结果落盘：" + file);
  } catch (e) {
    console.log("落盘失败（不影响门禁）：" + e?.message);
  }
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("GATE_FATAL", e?.message || e);
  process.exit(2);
});