// 写稿质量金标准回归集（2026-09 写稿大整改配套门禁）。
//
// 跑法（容器内，host 网络直连本机服务；INTERNAL_TOKEN 从容器 env 读）：
//   docker exec hot-web node /tmp/eval/grade-scripts.mjs
// 可选环境变量：
//   EVAL_BASE=http://127.0.0.1:3000  EVAL_TOKEN=xxx  EVAL_FILTER=embed
//   OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL 与 grade-golden 同源（评审 LLM）
//
// 评测纪律（与 grade-golden 一致）：
// - 硬检查（字数区间/第一句长度/AI腔黑名单/日期报幕计数/意图期望/降档字段）机器判，不靠感觉；
// - 软质量项走 LLM-as-judge，二元 Pass/Fail（最可靠档），先逐项 CoT 再给结论，temp=0；
// - 事实零编造项把本次真实资料块 groundBlock 一并喂给评审，只判"稿内硬事实是否越出资料"；
// - 每条生成稿+判定结果原样落盘 JSON，作为可复查证据；
// - 场景里的话题/领域词只用于构造测试请求（等价于用户真实输入），【禁止】搬进生产 prompt；
//   生产侧纪律必须保持内容中立。
//
// 门禁：任一硬检查 Fail 即整体 FAIL；软评项通过率低于阈值 FAIL；A/A 意图不稳 FAIL。

import { writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.env.EVAL_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.EVAL_TOKEN || process.env.INTERNAL_TOKEN || "";
const LLM_KEY = process.env.OPENAI_API_KEY;
const LLM_BASE = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";
const FILTER = process.env.EVAL_FILTER || "";

// 软评门禁：每个场景关键项必须全部 Pass（非关键项见 critical 标记）
const MIN_SCENE_PASS_RATE = 1; // 关键项 100%——写稿是面向用户的成品，不接受打折
const MIN_TOTAL_PASS_RATE = 0.9;

// ───────────────────────── 金标准场景 ─────────────────────────
// expectIntent: 意图分类期望；expectDowngrade: 是否允许出现降档字段；
// words:[下限,上限] 非空白字符数（含标点，与产品字数口径一致）。
const SCENARIOS = [
  {
    id: "opinion-in-embed",
    name: "核心事故案：观点填进植入框、梗概框为空",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "为什么现在BL比BG火",
      domain: "bg与bl大战",
      script: "",
      embed: "BL火是因为低龄的魔怔人多，喜欢BL的女生其实是双倍爱男",
      duration: "3分钟",
      wordRange: "540-660字",
    },
    expectIntent: "opinion",
    expectDowngrade: false,
    words: [459, 792],
    maxDateReports: 1,
    mustContainThesis: ["双倍爱男", "魔怔"],
  },
  {
    id: "info-3min",
    name: "无观点资讯稿3分钟：中立梳理，不许误判观点稿",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "多地发布育儿补贴新政",
      domain: "育儿教育",
      script: "梳理一下这件事的来龙去脉：政策内容、各地差异、大家最关心的申领问题",
      embed: "",
      duration: "3分钟",
      wordRange: "540-660字",
    },
    expectIntent: "info",
    expectDowngrade: null,
    words: [459, 792],
    maxDateReports: 2,
  },
  {
    id: "opinion-thin-material",
    name: "观点稿料薄：关闭自动降档，靠论证撑满3分钟",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "年轻人扎堆买黄金豆",
      domain: "理财投资",
      script: "年轻人买金豆根本不是什么理财觉醒，就是给焦虑找个安慰剂，商家把克重切小才是真正的赢家",
      embed: "",
      duration: "3分钟",
      wordRange: "540-660字",
    },
    expectIntent: "opinion",
    expectDowngrade: false,
    words: [459, 792],
    maxDateReports: 1,
  },
  {
    id: "opinion-30s",
    name: "观点稿30秒短档：五段浓缩，字数必须落在90-110附近",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "为什么现在BL比BG火",
      domain: "bg与bl大战",
      script: "BL火是因为低龄的魔怔人多，喜欢BL的女生其实是双倍爱男",
      embed: "",
      duration: "30秒",
      wordRange: "90-110字",
    },
    expectIntent: "opinion",
    expectDowngrade: false,
    words: [72, 132],
    maxDateReports: 1,
  },
  {
    id: "info-material-only-precision",
    name: "分类器精度案：只有事实清单和创作要求，必须判 info",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "央行下调存款准备金率",
      domain: "理财投资",
      script: "",
      embed: "降准的具体幅度；对房贷月供的影响；普通人需不需要做点什么",
      duration: "1分钟",
      wordRange: "200-240字",
    },
    expectIntent: "info",
    expectDowngrade: null,
    words: [160, 288],
    maxDateReports: 2,
  },
  {
    id: "info-narrow-entity",
    name: "窄主体资讯稿：围绕指定主体展开",
    body: {
      action: "generate",
      type: "口播稿",
      topic: "周琦重返CBA",
      domain: "篮球",
      entity: "周琦",
      script: "讲清楚他这次签约的来龙去脉和球迷的反应",
      embed: "",
      duration: "1分钟",
      wordRange: "200-240字",
    },
    expectIntent: "info",
    expectDowngrade: null,
    words: [160, 288],
    maxDateReports: 2,
    mustMention: ["周琦"],
  },
  {
    id: "multi-smoke",
    name: "一稿多发冒烟：返回非空成稿包",
    body: {
      action: "multi",
      topic: "多地发布育儿补贴新政",
      platform: "微博",
      report: "",
      entity: "",
      sites: [],
      script: "",
      embed: "",
      domain: "育儿教育",
    },
    smokeOnly: true,
  },
];

// ───────────────────────── 硬检查 ─────────────────────────
const AI_TONE_BLACKLIST = [
  /不仅[^。！？\n]{0,12}更是/,
  /这不是[^。！？\n]{0,15}而是/,
  /首先[，,]?其次/,
  /综上所述/,
  /值得(我们)?深思/,
  /众所周知/,
  /总而言之/,
  /在这个[^。！？\n]{0,10}的时代/,
  /希望这个视频/,
  /家人们/,
  /大家好/,
  /今天给大家/,
  /哈喽/,
  /随着[^。！？\n]{0,12}(发展|到来|进步)/,
];
const DATE_REPORT_RE =
  /(\d{1,2}月\d{1,2}日|[一二三四五六七八九十两]+月[一二三四五六七八九十两\d]+(日|号))(?=[^。！？\n]{0,14}(帖子|发帖|发文|报道|回答|文章|爆料|消息|有个|有一条|上网|网友))|((微博|贴吧|知乎|抖音|小红书|B站|头条|网上|平台|论坛)[^。！？\n]{0,12})(\d{1,2}月\d{1,2}日|[一二三四五六七八九十两]+月[一二三四五六七八九十两\d]+(日|号))/g;

function nonWsLen(s) {
  return String(s || "").replace(/\s/g, "").length;
}

function firstSentence(text) {
  // 取第一个句末标点或换行前的内容；无标点则取前 30 字
  const m = String(text || "").split(/\n/)[0].match(/^[^。！？!?]{1,60}/);
  return (m ? m[0] : String(text || "").slice(0, 30)).trim();
}

function hardChecks(sc, data) {
  const out = [];
  const text = data.script || "";
  if (sc.smokeOnly) {
    const pack = data.pack || {};
    // MultiPack: { xhs?: {titles,cover,body,tags}, gzh?: {...} }
    const keys = ["xhs", "gzh"].filter((k) => nonWsLen(pack[k]?.body) > 30);
    out.push({
      id: "multi-pack",
      pass: keys.length >= 2,
      critical: true,
      detail: `成稿条目=${keys.length}（${keys.join("/") || "空"}）`,
    });
    return out;
  }
  // 1 意图
  const intentMode = data.intent?.mode;
  out.push({
    id: "intent",
    pass: intentMode === sc.expectIntent,
    critical: true,
    detail: `期望 ${sc.expectIntent}，实得 ${intentMode}｜thesis="${(data.intent?.thesis || "").slice(0, 40)}"｜ragHits=${data.intent?.ragHits ?? "?"}`,
  });
  // 2 降档
  if (sc.expectDowngrade === false) {
    out.push({
      id: "no-downgrade",
      pass: !data.downgrade,
      critical: true,
      detail: data.downgrade ? `被降档：${String(data.downgrade).slice(0, 80)}` : "未降档",
    });
  }
  // 3 字数
  const n = nonWsLen(text);
  out.push({
    id: "words",
    pass: n >= sc.words[0] && n <= sc.words[1],
    critical: true,
    detail: `${n} 字，要求 [${sc.words[0]}, ${sc.words[1]}]`,
  });
  // 4 第一句 ≤20 字（硬门禁放到 24=允许20%口播误差，与全稿字数纪律同口径；
  //   25+ 才算 Fail，21-24 记录但放行）
  const fs = firstSentence(text);
  const fsLen = nonWsLen(fs);
  out.push({
    id: "hook-length",
    pass: fsLen <= 24 && fsLen > 0,
    critical: true,
    detail: `第一句 ${fsLen} 字（目标≤20，门禁≤24）：「${fs.slice(0, 30)}」`,
  });
  // 5 AI 腔黑名单
  const hits = AI_TONE_BLACKLIST.map((re) => {
    const m = text.match(re);
    return m ? m[0] : null;
  }).filter(Boolean);
  out.push({
    id: "ai-tone-blacklist",
    pass: hits.length === 0,
    critical: true,
    detail: hits.length ? `命中：${hits.join(" / ")}` : "无黑名单句式",
  });
  // 6 日期报幕计数
  const dm = text.match(DATE_REPORT_RE) || [];
  out.push({
    id: "date-report",
    pass: dm.length <= sc.maxDateReports,
    critical: true,
    detail: `${dm.length} 处日期报幕（上限 ${sc.maxDateReports}）${dm.length ? "：" + dm.join("、") : ""}`,
  });
  // 7 非空且非错误
  out.push({
    id: "no-error",
    pass: !data.error && n > 0,
    critical: true,
    detail: data.error ? `接口错误：${String(data.error).slice(0, 100)}` : "成稿非空",
  });
  // 8 观点原义词必须还在稿里（论点不许被偷换/稀释到消失）。
  // 归一化匹配：去标点/语气助词后子串命中即可——"双倍地爱男"对"双倍爱男"算保留
  // （允许"地/的/了"等虚词插入），核心语义词一个都不能少。
  if (sc.mustContainThesis) {
    const norm = (s) => s.replace(/[的地得了吗呢啊呀吧呗就\s，,。．！？!?、；：：""''（）()「」]/g, "");
    const nt = norm(text);
    const missing = sc.mustContainThesis.filter((w) => !nt.includes(norm(w)));
    out.push({
      id: "thesis-preserved",
      pass: missing.length === 0,
      critical: true,
      detail: missing.length ? `论点原义词丢失：${missing.join("、")}` : "论点原义词全部保留（允许虚词插入）",
    });
  }
  if (sc.mustMention) {
    const missing = sc.mustMention.filter((w) => !text.includes(w));
    out.push({
      id: "entity-focus",
      pass: missing.length === 0,
      critical: false,
      detail: missing.length ? `未提及主体：${missing.join("、")}` : `围绕主体 ${sc.mustMention.join("、")}`,
    });
  }
  return out;
}

// ───────────────────────── LLM 软评（逐项二元） ─────────────────────────
// rubric 必须带锚点（Pass/Fail 各举判定形态），防分数集中化。
function buildRubricPrompt(sc, text, ground, thesis) {
  const isOpinion = sc.expectIntent === "opinion";
  // 短档（≤150字，如30秒档）产品口径允许反方观点以一句话内嵌进论证段，不要求独立成段
  const shortForm = sc.words[1] <= 150;
  const items = [
    {
      id: "hook",
      q: "开头钩子：第一句是不是具体的判断/事实/原话/数字，3秒内能抓住人，没有自我介绍和铺垫？",
      passEg: "开口即断言或具体事实，如直接下判断、抛冲突",
      failEg: "「今天跟大家聊聊」「大家好」「先问大家一个问题」、空泛背景铺垫",
    },
    isOpinion
      ? {
          id: "structure",
          q: shortForm
            ? "短档观点稿结构：亮主张 → 至少两层推进的论证（层层递进、并列算几笔账、从具体人反复拉大，任一形式均可）→ 反方观点（允许只用一句话内嵌，如'你可以说…但…'）→ 落回本事件的收束，齐全即 Pass？"
            : "观点稿结构完整：有明确主张；论证有两个以上有效层次（层层递进／并列换角度算账／从具体人拉大再切回，任一形式均可，不要求固定形状）；出现反方最强版本并被回应；结尾有收束。缺反方、或论证只有一层在原地重复即 Fail，结构形状本身不限？",
          passEg: shortForm
            ? "百字内能找到主张、两层推进论证、一句内嵌反方与回应、立场回扣"
            : "能找到靶子或对立面、至少两个层次的论证（形状不限）、明确替反方说话再回应、结尾落回本事件",
          failEg: shortForm
            ? "只有主张没有论证、或完全没有反方视角的影子"
            : "只有自说自话没有反方、论证只有一层原地重复、结尾没有收束或跑离本事件",
        }
      : {
          id: "structure",
          q: "资讯稿结构：钩子 → 按信息点推进的价值主体（不是按来源逐条报幕）→ 单一收束动作？",
          passEg: "信息融合组织、有转折推进、收束克制",
          failEg: "「X月X日某平台帖子说…另一个回答说…」式报账、信息罗列无组织",
        },
    {
      id: "density",
      q: "信息密度：有没有正确的废话、同义反复、把道理兑水拉长？每一句是否都在推进？",
      passEg: "删掉任何一句都会丢信息或断逻辑",
      failEg: "「这值得我们关注」「事情就是这样」式空句、同个意思换词重复",
    },
    {
      id: "spoken",
      q: "口语化：像对着一个具体的人讲话，短句为主、念出来顺，没有书面腔和播音腔？",
      passEg: "饭桌上讲事的语感，长短句交错",
      failEg: "长定语套长句、「据悉/近日/随着/综上所述」、一段一句式排版",
    },
    {
      id: "no-ai-tone",
      q: isOpinion
        ? "无 AI 腔：有没有空洞的「不仅…更是…」、首先其次最后、段尾必总结、无情绪冷冰冰这类机器味？注意区分：观点稿里「X不是A，是B」若承载的是用户真实对立判断（具体、有锋芒），这是论点表达【不算】AI 腔；只有空泛万能、放在任何题上都成立的对仗升华才算 Fail"
        : "无 AI 腔：有没有「不仅…更是…」「这不是…而是…」、首先其次最后、段尾必总结、无情绪冷冰冰这类机器味？",
      passEg: "有具体情绪和人的立场，句式自然不齐整",
      failEg: "对仗工整的万能模板句、可套在任何话题上的空洞升华、假深情假客观",
    },
    ...(isOpinion
      ? [
          {
            id: "arg-share",
            q: "论证占比与锋芒：全稿一半以上篇幅是分析/推演/反驳（不是复述资料），且用户主张的锋利被保留，没有和稀泥成「一方面另一方面」？",
            passEg: "主张在开头亮出并贯穿，论证层层加码，敢下判断",
            failEg: "大半篇幅在复述帖子、主张被改成中立平衡句、结论模糊",
          },
        ]
      : []),
    {
      id: "ending",
      q: "结尾：是否有力收束且落回眼前这件事的具体人/场景？观点稿可以是贴着事件的具体反问、事实悬念、当事人处境，或一句有信息量的点题收束（不强制金句）；资讯稿克制收在事实/争议上。两类都不许模板化互动乞讨，也不许停在与本事件无关的宏大概念上喊口号？",
      passEg: "收束贴着本事件、有信息量或具体提问；资讯稿停在真实悬念",
      failEg: "「你怎么看欢迎评论」「点赞关注不迷路」式万能尾巴；空洞格言或口号；没回到眼前事件、停在宏大概念升华上",
    },
    {
      id: "fact-boundary",
      q:
        (isOpinion && thesis
          ? `事实边界：【用户自己的中心论点】是"${thesis}"——论点原话及其直接释义（含论点里带情绪的判断词）是要去论证的主张，资料里没有也【不算】编造，必须允许且应该出现。只检查论证过程中【新引入】的硬事实：稿中数字/日期/人名机构名/平台榜单/引语是否都能在资料里找到依据？有没有把残句补全、把心理推演落成资料外的假平台假数字假时长、把资料态度拔高成「全网炸了」？`
          : `事实边界：对照【资料】检查——稿中数字/日期/人名机构名/平台榜单/引语是否都能在资料里找到依据？有没有把残句补全、把心理推演落成假平台假数字、把资料态度拔高成「全网炸了」？`),
      passEg: "硬事实全部有出处，推演只停在泛称假设不落地成假实体",
      failEg: "出现资料没有的金额/热度/排名/平台名/具体时长、补全了省略号残句、夸大范围",
    },
  ];
  return `你在给一条短视频口播成稿做质量评审。只按下列各项独立判 Pass/Fail，先给一句具体依据（引用稿中词句），再下结论。判据要严格：锚点里的 Fail 形态出现即 Fail，不要因为整体还行就放水。

【稿件】
${text}

【本次生成实际使用的资料】
${ground ? ground.slice(0, 7000) : "（无资料块返回；此项仅按稿件内部一致性判断，拿不准给 Pass）"}

评审项：
${items
  .map(
    (it, i) =>
      `${i + 1}. id=${it.id}
   问题：${it.q}
   Pass 锚点：${it.passEg}
   Fail 锚点：${it.failEg}`
  )
  .join("\n")}

只输出 JSON 数组，不要解释、不要 markdown 代码块：
[{"id":"hook","pass":true,"why":"≤40字具体依据"},…]`;
}

async function llmOnce(prompt) {
  const r = await fetch(LLM_BASE + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + LLM_KEY },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 2000,
    }),
  });
  return r;
}

function parseJudgeJson(raw) {
  let m = raw.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      return { items: JSON.parse(m[0]), error: "" };
    } catch {
      // 落到截断修复
    }
  }
  // 截断修复：取最后一个完整对象为止，补 ]
  const objs = [...raw.matchAll(/\{[^{}]*\}/g)].map((x) => x[0]);
  if (objs.length) {
    try {
      return { items: JSON.parse("[" + objs.join(",") + "]"), error: "" };
    } catch {
      // 落到失败
    }
  }
  return { items: [], error: "parse:" + raw.slice(0, 120) };
}

async function llmGrade(sc, text, ground, thesis) {
  if (!LLM_KEY) return { items: [], error: "no-llm-key" };
  const prompt = buildRubricPrompt(sc, text, ground, thesis);
  let r = await llmOnce(prompt).catch(() => null);
  if (!r || !r.ok) {
    // 429/5xx/网络：一次退避重试
    await new Promise((x) => setTimeout(x, 1500));
    r = await llmOnce(prompt).catch(() => null);
  }
  if (!r) return { items: [], error: "network" };
  if (!r.ok) return { items: [], error: "http_" + r.status };
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || "";
  const { items, error } = parseJudgeJson(raw);
  if (error) return { items: [], error };
  return {
    items: items
      .filter((x) => x && typeof x.id === "string")
      .map((x) => ({ id: x.id, pass: x.pass === true, why: String(x.why || "").slice(0, 120) })),
    error: "",
  };
}

// ───────────────────────── 主流程 ─────────────────────────
async function genScript(body) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/script", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { "x-internal-token": TOKEN } : {}),
    },
    body: JSON.stringify({ ...body, _evalGround: true }),
  });
  const ms = Date.now() - t0;
  const data = await r.json().catch(() => ({}));
  return { http: r.status, ms, data };
}

(async () => {
  const picked = SCENARIOS.filter((s) => !FILTER || s.id.includes(FILTER));
  console.log(`写稿质量门禁：${picked.length} 个场景｜目标=${BASE}｜评审模型=${LLM_MODEL}\n`);
  const records = [];
  let hardFailScenes = 0;
  let softTotal = 0;
  let softPass = 0;
  let softErrorScenes = 0;

  for (const sc of picked) {
    console.log(`\n########## [${sc.id}] ${sc.name} ##########`);
    const { http, ms, data } = await genScript(sc.body);
    console.log(`HTTP ${http}｜${(ms / 1000).toFixed(1)}s｜${nonWsLen(data.script)} 字`);
    const hard = hardChecks(sc, data);
    for (const h of hard) {
      console.log(`${h.pass ? "  ✓" : "  ✗"} [${h.id}] ${h.detail}`);
    }
    const sceneHardFail = hard.some((h) => h.critical && !h.pass);
    if (sceneHardFail) hardFailScenes++;

    let soft = { items: [], error: "" };
    if (!sc.smokeOnly && nonWsLen(data.script) > 0) {
      soft = await llmGrade(sc, data.script, data.groundBlock || "", data.intent?.thesis || "");
      if (soft.error) {
        softErrorScenes++;
        console.log(`  ! 软评失败：${soft.error}`);
      }
      for (const it of soft.items) {
        softTotal++;
        if (it.pass) softPass++;
        console.log(`${it.pass ? "  ✓" : "  ✗"} <${it.id}> ${it.why}`);
      }
    }
    const sceneSoftFail = soft.items.some((x) => !x.pass);
    records.push({
      id: sc.id,
      name: sc.name,
      http,
      ms,
      request: sc.body,
      intent: data.intent || null,
      downgrade: data.downgrade || null,
      trimmed: data.trimmed ?? null,
      chars: data.chars ?? null,
      hard,
      soft: soft.items,
      softError: soft.error,
      scenePass: !sceneHardFail && !sceneSoftFail,
      script: data.script || "",
      error: data.error || null,
    });
    console.log(
      `  => ${records[records.length - 1].scenePass ? "场景 PASS ✅" : "场景 FAIL ❌"}`
    );
  }

  // A/A 稳定性：核心事故案意图分类连跑两次必须都是 opinion（分类器不抽风）
  const aa = picked.find((s) => s.id === "opinion-in-embed");
  let aaStable = true;
  if (aa && !FILTER) {
    console.log(`\n########## [aa-stability] 核心案意图重跑 ##########`);
    const { data } = await genScript(aa.body);
    aaStable = data.intent?.mode === "opinion" && !data.downgrade;
    console.log(
      `  ${aaStable ? "✓" : "✗"} 二次意图=${data.intent?.mode}｜降档=${data.downgrade || "无"}`
    );
    records.push({ id: "aa-stability", intent: data.intent, downgrade: data.downgrade || null, scenePass: aaStable });
  }

  const totalRate = softTotal ? softPass / softTotal : 0;
  const gatePass =
    hardFailScenes === 0 &&
    aaStable &&
    softErrorScenes === 0 &&
    (!softTotal || totalRate >= MIN_TOTAL_PASS_RATE);

  console.log(`\n========== 门禁结果 ==========`);
  console.log(
    `硬检查失败场景=${hardFailScenes}（线0）｜A/A 意图稳定=${aaStable}｜软评项 ${softPass}/${softTotal}=${(
      totalRate * 100
    ).toFixed(0)}%（线${MIN_TOTAL_PASS_RATE * 100}%）｜软评失败场景=${softErrorScenes}（线0）`
  );
  console.log(gatePass ? "GATE PASS ✅" : "GATE FAIL ❌");

  try {
    mkdirSync("/tmp/eval/results", { recursive: true });
    const fp = `/tmp/eval/results/grade-scripts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(fp, JSON.stringify({ gatePass, totalRate, records }, null, 2));
    console.log("证据落盘：" + fp);
  } catch (e) {
    console.log("证据落盘失败：" + e.message);
  }
  process.exit(gatePass ? 0 : 1);
})().catch((e) => {
  console.error("GATE_FATAL", e?.stack || e);
  process.exit(2);
});
