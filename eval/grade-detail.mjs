// 「查看详情」召回质量门禁（2026-09 切入角度检索契约配套）。
//
// 跑法（容器内）：
//   docker exec hot-web node /tmp/eval/grade-detail.mjs
// 可选：EVAL_BASE / EVAL_FILTER=slang
//
// 为什么全用确定性判定、不上 LLM 软评：检索评测的金标准是「证据标记召回」——
// 请求里带上【这条话题必须能找到的原词】，在返回的报道+参考标题/快照里做归一化命中，
// 再配「陷阱题必须被闸住」防过度召回。指标：
//   foundRecall  应召回场景的证据命中率（关键证据词必须命中、sites 非空、未误闸）
//   falsePass    陷阱题被硬答（应 needClarify 却出了报道）—— 必须 0
//   falseBlock   应召回场景被事实门误杀（needClarify）—— 必须 0
//   P95 延迟     检索链路体验回归
// 难例全部来自真实失败形态：亚文化 2-3 字黑话/蔑称、长角度句（日期+平台+元话语壳）、
// 圈内金句、中英混合缩写、概念问句回归、带主体热榜回归、纯元话语陷阱、裸指代陷阱。
// 场景词只用于构造请求（等价真实用户输入），【禁止】搬进生产代码/prompt。

import { writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.env.EVAL_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.EVAL_TOKEN || process.env.INTERNAL_TOKEN || "";
const FILTER = process.env.EVAL_FILTER || "";

// found：必须召回；clarify：必须闸住（防过度召回）
const SCENARIOS = [
  {
    id: "niche-slang-contract",
    name: "核心修复：亚文化蔑称角度句+显式检索契约（新UI形态）",
    body: {
      topic:
        "特质衍生向：BL 读者最出圈的争议标签就是各种蔑称——知乎 9 月 4 日的提问里列出了「腐女」「腐蟑螂」等一串称呼，可做一期这些称呼是怎么变味的",
      entity: "",
      keywords: ["腐女", "腐蟑螂", "蔑称"],
    },
    expect: "found",
    // 最尖的圈内原词必须真实出现在召回/报道里（只命中泛词不算召回成功）
    terms: ["腐蟑螂"],
    minSites: 3,
  },
  {
    id: "niche-slang-legacy-ui",
    name: "旧UI形态：无契约无主体，长句带2-3字黑话引号（引号启发式兜底）",
    body: {
      topic:
        "特质衍生向：BL 读者最出圈的争议标签就是各种蔑称——知乎 9 月 4 日的提问里列出了「腐女」「腐蟑螂」等一串称呼，可做「从腐女到腐蟑螂，这些称呼是怎么变味的」",
      entity: "",
    },
    expect: "found",
    terms: ["腐蟑螂"],
    minSites: 2,
  },
  {
    id: "circle-meme-phrase",
    name: "小众圈内金句原句（无主体无契约，金句本身就是检索指纹）",
    body: { topic: "经典我一个bl妹都想反bl了", entity: "" },
    expect: "found",
    terms: ["bl"],
    termLatin: true,
    minSites: 2,
  },
  {
    id: "angle-lead-strip",
    name: "角度标签+日期平台导语壳：剥壳后黑话金句必须召回",
    body: {
      topic:
        "考据向：9 月 13 日有微博称「经典我一个bl妹都想反bl了」，可做一期圈内黑话考据",
      entity: "",
    },
    expect: "found",
    terms: ["bl"],
    termLatin: true,
    minSites: 2,
  },
  {
    id: "mixed-lang-abbr",
    name: "中英混合圈子缩写成对检索（BL/BG 骂战）",
    body: {
      topic: "圈层内讧向：BL 与 BG 的长期互撕，可做一期两边为什么吵",
      entity: "",
      keywords: ["bl", "bg", "互撕"],
    },
    expect: "found",
    terms: ["bl"],
    termLatin: true,
    minSites: 2,
  },
  {
    id: "concept-ask-regression",
    name: "回归：概念问句（是什么梗）不允许被新事实门误伤",
    body: { topic: "city不city是什么梗", entity: "" },
    expect: "found",
    terms: ["city"],
    termLatin: true,
    minSites: 3,
  },
  {
    id: "entity-angle-regression",
    name: "回归：带主体角度条目（选手+颜值词）老链路不退化",
    body: { topic: "zont1x 颜值 男模", entity: "zont1x" },
    expect: "found",
    terms: ["zont1x"],
    termLatin: true,
    minSites: 3,
  },
  {
    id: "brand-new-entity-rescue",
    name: "全新造词救援：零索引新外号主体+相关领域角度、无检索契约（灰灰男案）",
    body: {
      // 主体用刻意生造、引擎零结果的词；角度句不带〔搜：〕契约（模拟模型漂移），
      // 句中唯一可检索的实名锚点是当事人/领域词——必须靠救援路（不带主体的角度句
      // 重扩展）取锚点补召回，并以多原词互证过事实门，而不是回"没找到公开资料"。
      topic:
        "财经理财向：借孙宇晨的暴富路径，讲灰产型财富为什么来得快也守不住，给普通人一份辨识清单",
      entity: "咘咘男",
      keywords: [],
    },
    expect: "found",
    // 救援必须拿回角度句里真实存在的锚点资料（新外号本身无资料可命中）
    terms: ["孙宇晨", "灰产"],
    minSites: 2,
  },
  {
    id: "trap-meta-only",
    name: "陷阱：纯编辑元话语无任何可检索对象——必须闸住",
    body: {
      topic: "特质衍生向：可以做一期关于这个的内容，大家怎么看",
      entity: "",
    },
    expect: "clarify",
  },
  {
    id: "trap-vague-anaphora",
    name: "陷阱：裸指代追问（那个事后来怎么样了）——必须闸住",
    body: { topic: "那个事后来怎么样了", entity: "" },
    expect: "clarify",
  },
];

function haystackOf(data) {
  const parts = [String(data?.report || "")];
  for (const s of data?.sites || []) {
    parts.push(String(s.title || ""), String(s.snippet || ""));
  }
  return parts.join("\n");
}

// 命门口径：中文按去空白子串；短拉丁词要求非字母边界（"bl" 不许命中 black/blog）。
function termHit(hay, term, latin) {
  const t = String(term).toLowerCase();
  if (latin) {
    return new RegExp(`(?<![a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(
      hay.toLowerCase()
    );
  }
  return hay.toLowerCase().replace(/\s+/g, "").includes(t.replace(/\s+/g, ""));
}

async function callDetail(body) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/detail", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { "x-internal-token": TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const data = await r.json().catch(() => ({}));
  return { http: r.status, ms, data };
}

(async () => {
  const picked = SCENARIOS.filter((s) => !FILTER || s.id.includes(FILTER));
  console.log(`详情召回门禁：${picked.length} 个场景｜目标=${BASE}\n`);
  const records = [];
  let falseBlock = 0;
  let falsePass = 0;
  let recallHit = 0;
  let recallTotal = 0;
  const lats = [];

  for (const sc of picked) {
    console.log(`\n########## [${sc.id}] ${sc.name} ##########`);
    const { http, ms, data } = await callDetail(sc.body);
    lats.push(ms);
    const blocked = !!data?.needClarify;
    const siteN = (data?.sites || []).length;
    const hay = haystackOf(data);
    const checks = [];

    if (sc.expect === "found") {
      recallTotal++;
      const notBlocked = !blocked;
      checks.push({ id: "not-clarified", pass: notBlocked, detail: blocked ? "被事实门闸住" : "正常放行" });
      const httpOk = http === 200;
      checks.push({ id: "http-200", pass: httpOk, detail: `HTTP ${http}` });
      const enoughSites = siteN >= (sc.minSites || 1);
      checks.push({ id: "sites-count", pass: enoughSites, detail: `sites=${siteN}（线≥${sc.minSites || 1}）` });
      const termResults = (sc.terms || []).map((t) => ({
        t,
        hit: termHit(hay, t, sc.termLatin),
      }));
      const termsOk = termResults.every((x) => x.hit);
      checks.push({
        id: "evidence-terms",
        pass: termsOk,
        detail: termResults.map((x) => `${x.hit ? "✓" : "✗"}${x.t}`).join(" "),
      });
      const reportOk = String(data?.report || "").length > 80;
      checks.push({ id: "report-nonempty", pass: reportOk, detail: `report=${String(data?.report || "").length}字` });
      if (notBlocked && httpOk && enoughSites && termsOk && reportOk) recallHit++;
      if (blocked) falseBlock++;
    } else {
      const clarified = blocked;
      checks.push({ id: "must-clarify", pass: clarified, detail: clarified ? "正确闸住" : "未闸住（过度召回）" });
      const noSites = siteN === 0;
      checks.push({ id: "clarify-no-sites", pass: noSites, detail: `sites=${siteN}（线=0）` });
      if (!clarified) falsePass++;
    }

    for (const c of checks) console.log(`${c.pass ? "  ✓" : "  ✗"} [${c.id}] ${c.detail}`);
    console.log(
      `  ${(ms / 1000).toFixed(1)}s｜candidates=${data?.searchMeta?.candidates ?? "?"} strongFacts=${data?.searchMeta?.strongFacts ?? "?"} queries=${(data?.searchMeta?.queries || []).slice(0, 6).join(" / ") || "?"}`
    );
    const scenePass = checks.every((c) => c.pass);
    if (!scenePass) console.log(`  => 场景 FAIL ❌`);
    records.push({
      id: sc.id,
      name: sc.name,
      http,
      ms,
      request: sc.body,
      blocked,
      sites: siteN,
      reportHead: String(data?.report || "").slice(0, 300),
      siteTitles: (data?.sites || []).slice(0, 8).map((s) => s.title),
      searchMeta: data?.searchMeta || null,
      checks,
      scenePass,
    });
  }

  const sorted = [...lats].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95) - 1] || sorted[sorted.length - 1] || 0;
  const gatePass = falsePass === 0 && falseBlock === 0 && recallHit === recallTotal;
  console.log(`\n========== 门禁结果 ==========`);
  console.log(
    `证据召回 ${recallHit}/${recallTotal}｜误杀falseBlock=${falseBlock}（线0）｜误放falsePass=${falsePass}（线0）｜P95=${(p95 / 1000).toFixed(1)}s`
  );
  console.log(gatePass ? "GATE PASS ✅" : "GATE FAIL ❌");

  try {
    mkdirSync("/tmp/eval/results", { recursive: true });
    const fp = `/tmp/eval/results/grade-detail-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(fp, JSON.stringify({ gatePass, recallHit, recallTotal, falseBlock, falsePass, p95Ms: p95, records }, null, 2));
    console.log("证据落盘：" + fp);
  } catch (e) {
    console.log("证据落盘失败：" + e.message);
  }
  process.exit(gatePass ? 0 : 1);
})().catch((e) => {
  console.error("GATE_FATAL", e?.stack || e);
  process.exit(2);
});
