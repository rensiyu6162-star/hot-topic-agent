// 热点相关性三级判定（buildGradePrompt）的多领域黄金回归集 + 门禁脚本。
//
// 跑法（容器内，依赖 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，与生产同源）：
//   node eval/grade-golden.mjs <route.ts 路径>
//   例：docker exec hot-web node /tmp/eval/grade-golden.mjs /tmp/route.ts
//
// 工作方式：
// 1. 从【生产源码 route.ts】中正则抽取 buildGradePrompt 的非 rescue 模板原文，用它构造真实
//    prompt，保证评测与线上严格同源——改了生产 prompt 不跑本集就是裸奔；
// 2. 领域画像用与生产 getBeatProfile 完全相同的 LLM 调用现场生成；
// 3. 每域案例含核心题（标题不出现领域名）/间接题/撞词·身份陷阱题，覆盖失败模式而非按模块分；
// 4. 分级期望：2=核心议题 1=间接但实质相关 0=撞词/灾祸/赛果/娱乐等无关；
// 5. 命中口径 lvl>=1。门禁线：陷阱类误纳(trapFP)=0、总精确率≥0.95、召回≥0.90；
//    未达门禁退出码 1，可接部署前阻断。
//
// 维护规矩（AI PM 评测纪律）：线上新发现的误判必须在这里加一行真实标题，只追加不改旧例；
// prompt 或判定流程改动必须先跑本集。prompt 中【禁止】硬塞领域词表，判定机制保持内容中立。

import { readFileSync } from "node:fs";

const KEY = process.env.OPENAI_API_KEY;
const BASE = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1").replace(
  /\/+$/,
  ""
);
const MODEL = process.env.OPENAI_MODEL || "deepseek-chat";
const ROUTE_PATH = process.argv[2] || "./src/app/api/chat/route.ts";

// 门禁线
const MIN_PRECISION = 0.95;
const MIN_RECALL = 0.9;
// 判定稳定后若出现边界波动，对分歧样例可跑多轮投票；当前 temperature=0 单轮即门禁。

const DOMAINS = [
  {
    name: "女性主义",
    cases: [
      { t: "如何看待脱口秀中谈到的女性困境？", exp: 2, kind: "core" },
      { t: "女子称被公职人员强奸公安不立案，复核认定有犯罪事实", exp: 2, kind: "core" },
      { t: "男子长期遭妻子家暴 法院发出人身安全保护令", exp: 2, kind: "core" },
      { t: "麻袋女孩倒中南大报到：家境贫寒女孩靠读书考入名校", exp: 1, kind: "indirect" },
      { t: "Hyrox失禁女选手未被处罚", exp: 1, kind: "indirect" },
      { t: "为什么大家都不愿意娶护士？", exp: 1, kind: "indirect" },
      { t: "女生在飞机上看到震撼的大国基建", exp: 0, kind: "trap" },
      { t: "女子澳门遗失的大疆在杭州找到了", exp: 0, kind: "trap" },
      { t: "2026年美网女单决赛，莱巴金娜三盘战胜萨巴伦卡首获美网冠军", exp: 0, kind: "trap" },
      { t: "丈夫割肝救妻手术成功 妻子含泪致谢", exp: 0, kind: "trap" },
      { t: "香港海面浮尸系内地女子", exp: 0, kind: "trap" },
      { t: "倪萍得知敬一丹去世哭到浑身发抖", exp: 0, kind: "trap" },
    ],
  },
  {
    name: "电竞",
    cases: [
      { t: "S15全球总决赛决赛今晚打响 LPL两队会师", exp: 2, kind: "core" },
      { t: "Faker出道第十年再进世界赛决赛", exp: 2, kind: "core" },
      { t: "官方通报：两名选手因假赛被终身禁赛", exp: 2, kind: "core" },
      { t: "知名中单选手宣布退役 曾两夺MSI冠军", exp: 2, kind: "core" },
      { t: "大学开设电子竞技运动与管理专业 今年扩招200人", exp: 1, kind: "indirect" },
      { t: "电竞酒店深夜起火 住客从二楼跳下逃生", exp: 0, kind: "trap" },
      { t: "国产显卡新品发布 性能提升40%", exp: 0, kind: "trap" },
      { t: "小学生偷拿家长手机充值游戏被发现", exp: 0, kind: "trap" },
      { t: "小区大爷霸占健身器材打太极", exp: 0, kind: "trap" },
      { t: "韩路称选手大便失禁就该叫停比赛", exp: 0, kind: "trap" },
    ],
  },
  {
    name: "篮球",
    cases: [
      { t: "NBA季后赛对阵出炉 湖人和勇士首轮相遇", exp: 2, kind: "core" },
      { t: "周琦与老东家完成签约 新赛季重返CBA", exp: 2, kind: "core" },
      { t: "中国男篮公布亚洲杯12人名单", exp: 2, kind: "core" },
      { t: "库里常规赛三分总数突破4000个", exp: 2, kind: "core" },
      { t: "前国手举办退役仪式 姚明到场致辞", exp: 1, kind: "indirect" },
      { t: "楼下篮球场夜间灯光太亮 居民投诉要求关灯", exp: 0, kind: "trap" },
      { t: "某中学初三年级篮球赛因雨延期", exp: 0, kind: "trap" },
      { t: "网红在野球场与人发生口角被行政拘留", exp: 0, kind: "trap" },
      { t: "商场篮球机挑战赛冠军赢得十枚游戏币", exp: 0, kind: "trap" },
    ],
  },
  {
    name: "理财投资",
    cases: [
      { t: "央行宣布下调存款准备金率0.5个百分点", exp: 2, kind: "core" },
      { t: "A股全天成交额突破两万亿元 北向资金净流入", exp: 2, kind: "core" },
      { t: "国际金价再创历史新高 金店一天三调价", exp: 2, kind: "core" },
      { t: "多家银行下调存量房贷利率", exp: 2, kind: "core" },
      { t: "年轻人开始扎堆买黄金豆 银行柜员称咨询量翻倍", exp: 1, kind: "indirect" },
      { t: "老王买彩票中了五百万请全村吃饭", exp: 0, kind: "trap" },
      { t: "银行柜员技能比武 点钞最快者9秒数完一万", exp: 0, kind: "trap" },
      { t: "小学生把压岁钱藏书包里被洗衣机洗碎", exp: 0, kind: "trap" },
      { t: "寺庙功德箱一年收入被曝全归和尚个人", exp: 0, kind: "trap" },
    ],
  },
  {
    name: "育儿教育",
    cases: [
      { t: "教育部发布中小学课后服务新规范 秋季学期执行", exp: 2, kind: "core" },
      { t: "今年高考报名人数再创新高 复读生占比上升", exp: 2, kind: "core" },
      { t: "多地幼儿园因生源不足关停 学前教育进入调整期", exp: 2, kind: "core" },
      { t: "多省发放育儿补贴 三孩家庭每月领五百", exp: 2, kind: "core" },
      { t: "儿童医院门诊量迎高峰 医生提醒注意流感", exp: 1, kind: "indirect" },
      { t: "男童在小区滑梯上摔骨折 家长质疑器材老化", exp: 0, kind: "trap" },
      { t: "熊猫幼崽学爬树摔下木架 饲养员一把接住", exp: 0, kind: "trap" },
      { t: "家长群里因为教师节送不送礼吵翻", exp: 1, kind: "indirect" },
    ],
  },
  {
    name: "AI科技",
    cases: [
      { t: "新发布的大模型在数学基准上首次超过人类专家平均水平", exp: 2, kind: "core" },
      { t: "OpenAI发布新一代多模态模型 支持实时语音", exp: 2, kind: "core" },
      { t: "国产AI芯片开始大规模供货互联网大厂", exp: 2, kind: "core" },
      { t: "大三学生用AI写期末论文被学校记过", exp: 1, kind: "indirect" },
      { t: "团伙用AI换脸冒充亲友诈骗 多地警方预警", exp: 1, kind: "indirect" },
      { t: "电动自行车进楼充电起火 物业紧急排查", exp: 0, kind: "trap" },
      { t: "老人误信短视频伪科普 把退烧药当感冒药连吃三天", exp: 0, kind: "trap" },
      { t: "超市自助收银机坏了 顾客排队半小时", exp: 0, kind: "trap" },
    ],
  },
];

// 从生产源码抽取 buildGradePrompt 非 rescue 分支的模板原文（backtick 内允许 ${...}），
// 以及灰区复核话术（grade-review-note 标记之间），保证门禁与线上同流程同话术。
function loadProductionPrompt() {
  const src = readFileSync(ROUTE_PATH, "utf8");
  const m = src.match(/if \(!rescue\) \{\s*return `([\s\S]*?)`;\s*\}/);
  if (!m)
    throw new Error(
      `未能从 ${ROUTE_PATH} 抽取 buildGradePrompt 模板，生产代码结构可能已变，门禁拒绝运行`
    );
  const reviewM = src.match(
    /grade-review-note-start \*\/ `([\s\S]*?)`; \/\* grade-review-note-end/
  );
  if (!reviewM)
    throw new Error(
      `未能从 ${ROUTE_PATH} 抽取 GRADE_REVIEW_NOTE（grade-review-note 标记缺失），门禁拒绝运行`
    );
  const noteM = src.match(
    /grade-appeal-note-start \*\/ `([\s\S]*?)`; \/\* grade-appeal-note-end/
  );
  if (!noteM)
    throw new Error(
      `未能从 ${ROUTE_PATH} 抽取 GRADE_APPEAL_NOTE（grade-appeal-note 标记缺失），门禁拒绝运行`
    );
  const build = new Function(
    "name",
    "profile",
    "list",
    `"use strict"; return \`${m[1]}\`;`
  );
  return { build, reviewNote: reviewM[1], appealNote: noteM[1] };
}

async function getProfile(name) {
  const prompt = `我在做"按领域筛今日热点"的功能，领域是「${name}」，没有额外释义。
请用不超过120字的大白话，写清长期关注这个领域的读者/编辑真正关心的是哪些议题、哪类人群、哪些处境与争议，供判断热点相关性时使用。
只输出这段描述本身：连贯成句，不要分条、不要罗列关键词、不要标题和任何解释。`;
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || name;
}

async function grade(buildPrompt, name, profile, cases) {
  const list = cases.map((c, i) => `${i}. 测试｜${c.t}`).join("\n");
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: buildPrompt(name, profile, list) }],
      temperature: 0,
    }),
  });
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || "";
  const mm = raw.match(/\[[\s\S]*?\]/);
  if (!mm) return { byI: new Map(), parseError: raw.slice(0, 200) };
  try {
    return { byI: new Map(JSON.parse(mm[0]).map((o) => [Number(o.i), o])), parseError: "" };
  } catch {
    return { byI: new Map(), parseError: raw.slice(0, 200) };
  }
}

// 与生产 reviewGrayVetoes 同构：3 票全 temp0——严格单条 / 反驳式（带批量why）/ 宽松非对称。
// ≥2 票判 0 才否决；任何失败按保留（fail-open）。
async function reviewVeto(buildPrompt, notes, name, profile, cases, i, why) {
  const solo = `${i}. 测试｜${cases[i].t}`;
  const base = buildPrompt(name, profile, solo);
  const variants = [
    base,
    base + notes.appealNote.replace("__WHY__", (why || "").replace(/["\n]/g, " ").slice(0, 60)),
    base + notes.reviewNote,
  ];
  const oneVote = async (content) => {
    const callOnce = async () => {
      const r = await fetch(BASE + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content }],
          temperature: 0,
        }),
      });
      if (!r.ok) throw new Error("vote_http_" + r.status);
      const raw = (await r.json()).choices?.[0]?.message?.content || "";
      const parseLvl = () => {
        // JSON 损坏（裸引号、截断缺括号）时退化为直接抽 lvl，与生产同构
        const mm = raw.match(/\[[\s\S]*?\]/);
        if (mm) {
          try {
            const arr = JSON.parse(mm[0]);
            const o = arr.find((x) => Number(x?.i) === i) || arr[0];
            if (o && [0, 1, 2].includes(Number(o.lvl))) return Number(o.lvl) === 0 ? 0 : 1;
          } catch {
            // 落到正则
          }
        }
        const lm = raw.match(/"lvl"\s*:\s*([012])/);
        return lm && lm[1] === "0" ? 0 : 1;
      };
      return { v: parseLvl(), raw };
    };
    try {
      return await callOnce();
    } catch {
      await new Promise((r) => setTimeout(r, 800));
      try {
        return await callOnce();
      } catch {
        return 1;
      }
    }
  };
  // 同一条目的 3 票并发；不同条目由调用方串行，避免限流导致 fail-open 集体失真
  const votes = await Promise.all(variants.map(oneVote));
  if (process.env.GATE_DEBUG) {
    const zeros = votes.filter((x) => x.v === 0).length;
    console.log(`[debug-vote] ${name} #${i} votes=${votes.map((x) => x.v).join(",")}`);
    if (zeros >= 2)
      votes.forEach((x, k) => console.log(`  raw${k}: ${String(x.raw).slice(0, 220)}`));
  }
  return votes.filter((x) => x.v === 0).length >= 2;
}

(async () => {
  if (!KEY) {
    console.error("缺少 OPENAI_API_KEY");
    process.exit(2);
  }
  const { build: buildPrompt, reviewNote, appealNote } = loadProductionPrompt();
  const notes = { reviewNote, appealNote };
  let tp = 0, fp = 0, tn = 0, fn = 0, trapFP = 0, lvlMismatch = 0, parseFail = 0, vetoN = 0;

  for (const d of DOMAINS) {
    const profile = await getProfile(d.name);
    const { byI, parseError } = await grade(buildPrompt, d.name, profile, d.cases);
    console.log(`\n########## ${d.name} ##########`);
    if (parseError) {
      parseFail++;
      console.log("解析失败：", parseError);
    }
    // 阶段2.5：批量判 1 的灰区条目，逐条串行跑 3 票独立复核（与生产同构）
    const grayIdx = d.cases
      .map((c, i) => i)
      .filter((i) => Number(byI.get(i)?.lvl) === 1);
    const vetoFlags = [];
    for (const i of grayIdx) {
      vetoFlags.push(
        await reviewVeto(buildPrompt, notes, d.name, profile, d.cases, i, String(byI.get(i)?.why || ""))
      );
    }
    const vetoSet = new Set(grayIdx.filter((_, k) => vetoFlags[k]));
    vetoN += vetoSet.size;
    if (process.env.GATE_DEBUG)
      console.log(
        `[debug-gray] ${d.name} grayIdx=[${grayIdx.join(",")}] flags=[${vetoFlags
          .map((f) => (f ? "V" : "k"))
          .join(",")}] vetoSet=[${[...vetoSet].join(",")}]`
      );

    d.cases.forEach((c, i) => {
      const o = byI.get(i);
      let lvl = o ? Number(o.lvl) : -1;
      if (lvl === 1 && vetoSet.has(i)) lvl = 0;
      const hit = lvl >= 1;
      const should = c.exp >= 1;
      if (hit && should) tp++;
      else if (hit && !should) {
        fp++;
        if (c.kind === "trap") trapFP++;
      } else if (!hit && !should) tn++;
      else fn++;
      if (hit && should && lvl !== c.exp) lvlMismatch++;
      const flag = hit === should ? " " : "✗";
      const tag = vetoSet.has(i) ? " [复核否决]" : "";
      console.log(
        `${flag} 期${c.exp} 判${lvl < 0 ? "X" : lvl} [${c.kind}]${tag} ${c.t.slice(0, 30)} | ${
          o?.why || "(无返回)"
        }`
      );
    });
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  console.log(`\n========== 门禁结果 ==========`);
  console.log(
    `TP=${tp} FP=${fp} TN=${tn} FN=${fn}｜精确率=${precision.toFixed(3)}（线${MIN_PRECISION}）｜召回=${recall.toFixed(3)}（线${MIN_RECALL}）｜陷阱误纳=${trapFP}（线0）｜复核否决=${vetoN}｜1/2层级漂移=${lvlMismatch}｜解析失败域=${parseFail}`
  );
  const pass =
    precision >= MIN_PRECISION && recall >= MIN_RECALL && trapFP === 0 && parseFail === 0;
  console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("GATE_FATAL", e?.message || e);
  process.exit(2);
});
