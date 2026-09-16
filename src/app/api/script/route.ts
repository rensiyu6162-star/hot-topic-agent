import { NextRequest, NextResponse } from "next/server";
import {
  ANTI_AI_RULES,
  pickRelevantTemplates,
  renderExcerpts,
  renderTemplateOutlines,
} from "../_shared/templates";
import {
  classifyScriptIntent,
  heuristicIntent,
  OPINION_FACT_BOUNDARY,
  INFO_NARRATIVE_RULE,
  buildInfoFactTail,
  HOOK_QUOTE_RULE,
  type ScriptIntent,
} from "../_shared/scriptIntent";
import { retrieveVoiceCorpus, formatKnowledge } from "../../../lib/rag";
import { searxSearchUnion } from "../../../lib/searx";
import { crawlerSearch } from "../../../lib/crawler";
import {
  fetchDocs,
  renderDocsBlock,
  planFetchOrder,
  cnChars,
  type ArticleLink,
  type RankedLink,
} from "../../../lib/articleFetch";
import { queryPlan, sanitizeEntityCandidate } from "../../../lib/relevance";
import { fixAgeClaims } from "../../../lib/ageGuard";
import { redactUngroundedPrices } from "../../../lib/priceGuard";
import { guardQuotes } from "../../../lib/quoteGuard";
import { fixNumberDrift } from "../../../lib/numberGuard";
import { getLlm, isInternalRequest, llmChatJson, llmErrorAction, resolveRequestLlm, setRequestLlm } from "../../../lib/llm";
import {
  buildAssociationMaterial,
  proposeAssociationAxes,
  gatherProposalEvidence,
  renderSelectedBlock,
  rememberProposal,
  recallProposal,
  toPublicAxes,
  type AssociationResult,
  type AssociationAxis,
  type AssociationSelection,
} from "../../../lib/association";

// 口播稿生成统一走 llmChatJson：401/402/429 抛带分类的 LlmApiError，
// 顶层 catch 据此返回「配 Key / 去充值」引导；此前直连不看 res.ok，
// 欠费时拿到错误 JSON 静默变成空稿 502，用户根本不知道该充值。
async function callLLM(prompt: string): Promise<string> {
  const llm = getLlm();
  const json = await llmChatJson(
    llm,
    { messages: [{ role: "user", content: prompt }] },
    120000
  );
  return (json.choices?.[0]?.message?.content || "").trim();
}

// 无依据历史对比句剔除（2026-09 评测实证）：口播稿爱写"去年这时候，这价格连零头都不够"
// 这类跨年对比，资料里没有历史数字就是纯编造。句中含历史时间锚点（去年/前年/往年/
// 十年前/曾经那时候）而资料原文也没出现同一时间词的，整句删除；资料本身提到"去年/此前"
// 的时间线则保留。
function dropUngroundedHistory(text: string, material: string): string {
  if (!text) return text;
  const anchors = ["去年", "前年", "往年", "十年前", "前些年", "搁以前", "放在以前", "曾几何时"];
  const mat = material || "";
  return text
    .split(/(?<=[。！？!?\n])/)
    .filter((s) => {
      const hit = anchors.find((a) => s.includes(a));
      if (!hit) return true;
      return mat.includes(hit);
    })
    .join("");
}

// 退化占位句剔除（2026-09 评测实证）：料薄+字数压力下模型会吐模板填空式残句，如
// "电池成本占整车售价极高到极高""产能利用率只有极低""占5%到5%""多平台合计。"
// ——这种句子不承载任何事实，发出去就是事故。按小句粒度删除含以下特征的片段：
// ①X到X/X至X 两端完全同词（含同数字+同单位）；②"只有/达到/高达+极/很X"程度词悬空；
// ③≤10字且以"合计/累计"收尾的半截句。删完顺带清理残留标点。
const DEGEN_DUP_RE =
  /(\d+(?:\.\d+)?|[一-鿿]{1,6})\s*([%％元块万亿度岁分局个倍]?)\s*[到至~\-—]\s*\1\s*([%％元块万亿度岁分局个倍]?)/;
const DEGEN_DEGREE_RE =
  /(?:只有|仅有|达到|高达|低至|为|有|是)\s*(?:极高|极低|非常高|非常低|很高|很低|极大|极小|超大|超小)(?:[，,。．！？、；;]|$)/;
const DEGEN_FRAG_RE = /^[一-鿿\w]{2,10}(?:合计|累计)(?:[。．！？]|$)/;
function dropDegenerateClauses(text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[，,；;。．！？!?])/)
        .filter((seg) => {
          const s = seg.trim();
          if (!s) return true;
          if (DEGEN_DUP_RE.test(s)) return false;
          if (DEGEN_DEGREE_RE.test(s)) return false;
          if (DEGEN_FRAG_RE.test(s)) return false;
          return true;
        })
        .join("")
    )
    .join("\n")
    .replace(/[，,；;]\s*([。．！？])/g, "$1")
    .replace(/([，,。．！？；;])\1+/g, "$1")
    .replace(/^[，,。．；;\s]+/gm, "");
}

// 无依据时长断言剔除（2026-09 评测实证）：资讯稿把"拿了4年顶薪合同"推演成
// "等了四年才穿上队服"——精确时长得有资料原句。和 dropUngroundedHistory 同思路，
// 按小句删除。阿拉伯/中文数字归一后比对（资料写"4年"、稿写"四年"视为有依据）；
// 不碰 4 位年份（2024年）、年龄（19岁，ageGuard 管）、"年代/年级/年轻/年度"等非时长词。
const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
function cnSmallNumToInt(s: string): number | null {
  if (/^\d{1,3}$/.test(s)) return Number(s);
  if (s === "十") return 10;
  let n = 0;
  if (s.startsWith("十")) {
    n = 10 + (CN_NUM[s[1]] ?? 0);
  } else if (s.includes("十")) {
    const [a, b] = s.split("十");
    n = (CN_NUM[a] ?? 1) * 10 + (b ? CN_NUM[b] ?? 0 : 0);
  } else if ([...s].every((ch) => ch in CN_NUM)) {
    // "三四""五六"是约数不是精确时长，交给 prompt 纪律，不进机器守卫
    if (s.length > 1) return null;
    n = CN_NUM[s[0]];
  } else return null;
  return n > 0 && n <= 999 ? n : null;
}
const DURATION_RE = /(?<![\d.])(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(年|个月|天|周年)(?![代级轻度底])/g;
function groundedDurationSet(material: string): Set<string> {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  DURATION_RE.lastIndex = 0;
  while ((m = DURATION_RE.exec(material || ""))) {
    const n = cnSmallNumToInt(m[1]);
    if (n !== null) set.add(`${n}:${m[2]}`);
  }
  return set;
}
function dropUngroundedDurations(text: string, material: string): string {
  if (!text) return text;
  const grounded = groundedDurationSet(material);
  const bad = (seg: string): boolean => {
    let m: RegExpExecArray | null;
    DURATION_RE.lastIndex = 0;
    while ((m = DURATION_RE.exec(seg))) {
      const n = cnSmallNumToInt(m[1]);
      if (n !== null && !grounded.has(`${n}:${m[2]}`)) return true;
    }
    return false;
  };
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[，,；;。．！？!?])/)
        .filter((seg) => !bad(seg))
        .join("")
    )
    .join("\n")
    .replace(/[，,；;]\s*([。．！？])/g, "$1")
    .replace(/([，,。．！？；;])\1+/g, "$1")
    .replace(/^[，,。．；;\s]+/gm, "");
}

// 微超红线的确定性收口（2026-09 评测实证）：30 秒档 133/138 字超红线几个字时，LLM
// "再删一点"指令常整段重写甚至越压越长（micro 实测压不动），白花一次调用还增加波动。
// 微超时优先纯代码手术：只删句中【话语标记/填充成分】——删掉不损失任何事实信息与论点
// 结构；够不到红线就返回 null，交回给 LLM 微压（不硬凑）。观点稿/资讯稿均可用：
// 词表全部是语篇衔接成分，不动论点词、数字、人名、引语。每条 [正则, 替换串] 必须保留
// 前导标点（"A，说白了，B"→"A，B"），不能把两个小句直接焊死。
const FILLER_TOKENS: [RegExp, string][] = [
  [/(^|[，,。！？\s])(?:话说回来|我跟你讲|你还别说|不得不说|众所周知|总而言之|归根结底|换句话说|说白了|讲真的?|有一说一)[，,]?/g, "$1"],
  // 立场口头禅（删后判断句直接开口，锋芒不减）："我偏说：不是A是B"→"不是A是B"
  [/(^|[，,。！？\s])我偏说[：:]?/g, "$1"],
  [/(?:事实上|实际上|老实说|坦白讲|客观来讲)[，,]/g, ""],
  [/(?:在我看来|个人觉得|我一直觉得|你有没有想过|你想想看|大家要知道|我们都知道|你要知道|我告诉你)[，,]?/g, ""],
  // 反问前缀只在小句开头删，避开"坚持到底/究其究竟"等词内命中
  [/(^|[，,。！？\s])(?:到底|究竟)(?=[^，,。！？\s])/g, "$1"],
  // 否定前的纯强化副词："根本没给→没给""压根不是→不是"，命题含义不变
  [/(?:压根|根本|丝毫)(?=[没无未不非])/g, ""],
  // 让步发语词："对，但…/是的，不过…/没错，因为…"删发语保留反驳，语义不变
  [/(^|[。．！？!?\s])(?:对|是的|没错|有道理)[，,](?=但|可|不过|然而|因为)/g, "$1"],
  [/[，,](?:其实|反正|总之|当然)[，,]/g, "，"],
  // 副词"连…都/也"的"连"："女人连入场资格都没有"→"女人入场资格都没有"，语气略损、
  // 命题不变。两道保险防词内误删：①后面 12 字内必须有"都/也"呼应（连锁/连接句没有）；
  // ②"连锁/连接/连续/连任/连夜/连累…"成词语素直接排除。
  [/连(?![锁接续队长任夜声载带累绵亘])(?=[^，,。！？!?]{1,12}[都也])/g, ""],
  // 小句开头的"同样"："同样搞陷害，BL喊…"→"搞陷害，BL喊…"对比义由后文两个分句承载
  [/(^|[，,。！？\s])同样(?=[^，,。！？\s])/g, "$1"],
  // "问这话的人→问话的人、说这话→说话"：指示代词"这"在此类动词宾语里零信息
  [/(问|说|听|讲)这话/g, "$1话"],
  // 递进副词"甚至"："北京队甚至做好了放人准备"→"北京队做好了放人准备"，事实不变
  [/甚至/g, ""],
  // "记者去问近况→记者问近况"：趋向义在这类言说动词前是虚的
  [/去问/g, "问"],
];

// 词表核心：limit>0 时每删一次就复检、达标立即收（不多删）；limit<=0 表示不管达标、
// 把整张词表删满（超红线兜底 step ① 要的是"尽可能瘦"，由调用方再复算）。
// 替换必须走【正则】而不是字符串：replacement 里带 "$1"（保留前导标点），字符串模式下
// "$1" 不会被解析成捕获组，会把字面量 "$1" 打进正文（单测实证："说白了，A"→"$1A"）。
// 故用无 g 标志的单次正则，每轮只消掉当前第一处匹配，保持"删一次复检一次"的原语义。
function stripFillerTokens(text: string, limit: number): string {
  const nws = (s: string) => s.replace(/\s/g, "").length;
  let cur = text;
  for (const [re, rep] of FILLER_TOKENS) {
    const one = new RegExp(re.source);
    for (let guard = 0; guard < 20; guard++) {
      if (limit > 0 && nws(cur) <= limit) return cur;
      if (!one.test(cur)) break;
      const next = cur.replace(one, rep).replace(/[，,]{2,}/g, "，");
      if (!next.trim() || next === cur) break;
      cur = next;
    }
    if (limit > 0 && nws(cur) <= limit) return cur;
  }
  return cur;
}

function microCutFillers(text: string, limit: number, floor: number): string | null {
  if (!text) return null;
  const cur = stripFillerTokens(text, limit);
  const chars = cur.replace(/\s/g, "").length;
  if (chars > limit || chars < floor) return null;
  return cur;
}

// 超红线确定性兜底（2026-09 评测实证）：LLM 两轮压缩后仍可能压不动而超红线（实测 30 秒档
// 133/135/136/138 反复出现，旧逻辑"更短且不低于下限就采纳"并不要求 ≤ 红线，于是微超线的稿
// 被当达标放行），门禁 words 硬检查因此随机挂。这里在【所有压缩/守卫/扩写都走完】之后补一道
// 纯代码削减，不再花钱调用模型：
//   ① 话语标记词（FILLER_TOKENS，删了不损失事实与论点，见上）；
//   ② 最短的"无信息载体"小句——不含数字（硬事实载体）、不含引号（引语）、不在首句（钩子）
//      与末句（收束/反问）、不含用户植入框原话（防丢用户点名的论点）。
// 每轮只删一个小句、删完复算，降到红线内即止；削到下限以下或已无可删就原样返回——宁可留人审，
// 也不为了达标把稿子删秃。小句切分/保护规则只看表面特征（数字、引号、位置），对任意话题一视同仁。
function reduceToRedline(
  text: string,
  limit: number,
  floor: number,
  protect: string
): string | null {
  if (!text || limit <= 0) return null;
  const chars = (s: string) => s.replace(/\s/g, "").length;
  const stripped = stripFillerTokens(text, 0);
  if (chars(stripped) <= limit) return chars(stripped) >= floor ? stripped : null;
  const sents = stripped.match(/[^。．！？!?]+[。．！？!?]*/g) || [];
  if (sents.length < 3) return null;
  const hasNum = (s: string) => /\d|[一二三四五六七八九十百千万亿两]/.test(s);
  const hasQuote = (s: string) => /[“”"'「」『』]/.test(s);
  const parts = sents.map((s) => {
    const tail = (s.match(/[。．！？!?]+$/) || [""])[0];
    const core = tail ? s.slice(0, s.length - tail.length) : s;
    return { tail, clauses: core.split(/[，,]/).filter((c) => c.trim()) };
  });
  const prot = coreOf(protect || "");
  let cur = stripped;
  for (let round = 0; round < 30 && chars(cur) > limit; round++) {
    const cands: { si: number; ci: number; len: number }[] = [];
    parts.forEach((p, si) => {
      if (si === 0 || si === parts.length - 1) return;
      if (p.clauses.length <= 1) return;
      const whole = p.clauses.join("，");
      if (hasNum(whole) || hasQuote(whole)) return;
      p.clauses.forEach((c, ci) => {
        const t = c.replace(/[\s。．！？!?]/g, "");
        if (t.length < 6) return;
        const core = coreOf(t);
        if (prot && core && prot.includes(core)) return;
        cands.push({ si, ci, len: t.length });
      });
    });
    if (!cands.length) break;
    cands.sort((a, b) => a.len - b.len);
    parts[cands[0].si].clauses.splice(cands[0].ci, 1);
    cur = parts.map((p) => p.clauses.join("，") + p.tail).join("");
  }
  if (chars(cur) > limit || chars(cur) < floor) return null;
  return cur;
}

// 资讯稿超长机器收尾（2026-09 评测实证）：LLM 两轮压缩后仍可能超红线 10-20 字，
// 且往往只差在结尾多了一段【无数字、无问号】的纯行动呼吁/重复总结（如"申领之前先看
// 三件事……"）。观点稿绝不调用（金句反问是核心结构件）。从尾段向前逐段删，删到
// 限内即止；至少保留两个自然段，宁可不动也不删秃。只删不含任何数字（硬事实载体）
// 且不含问号（真实互动）的段落，最大限度避免误杀信息。
function trimOverlongInfoTail(text: string, limit: number): string {
  if (!text || text.replace(/\s/g, "").length <= limit) return text;
  const hasNum = (s: string) => /\d|[一二三四五六七八九十百千万零两]/.test(s);
  const paras = text.split(/\n+/).filter((p) => p.trim());
  if (paras.length < 3) return text;
  const kept = [...paras];
  while (kept.length >= 3 && kept.join("").replace(/\s/g, "").length > limit) {
    const tail = kept[kept.length - 1];
    if (hasNum(tail) || /[？?]/.test(tail)) break; // 尾段有硬事实或真提问，停止
    kept.pop();
  }
  return kept.join("\n");
}

// 首句断句（2026-09 评测实证）：模型偶尔把钩子写成 30-40 字的长复合句
// （"周琦没进14人大名单，8月21日名单内线是……"），prompt 写了≤20字仍偶发。
// 出口纯文本手术：第一句（首个句末标点前）超 24 字且内部 6-24 字位置有逗号/破折号时，
// 把第一个分隔点改成句号——口播上本就该在此停顿，不改词不删信息。只动首句一处。
// 下限 6（曾实测"每个月工资到手，"7字位逗号未切导致 39 字长句）：6-7 字的引导小句
// （"工资到手，""名单一出，"）本身就是完整呼吸句；切点后剩余部分不足 6 字则不动。
// 2026-09 补漏：旧版要求首句【末尾必须有句末标点】才动手术，于是"首段是一串逗号连缀、
// 末尾没句号"的形态（模型低频但确有）完全漏过——首句按整段长度超线。改为取"首个句末
// 标点前的整段连续文本"作 head，末尾有无标点都判；切点规则与阈值一律不变。
function breakLongFirstSentence(text: string): string {
  if (!text) return text;
  const firstPara = text.split(/\n/)[0];
  const head = (firstPara.match(/^[^。．！？!?]+/) || [""])[0];
  if (head.length < 25) return text;
  const sep = head.match(/^(.{6,24}?)([，,]|——|—|：|:)/);
  if (!sep) return text;
  const leadLen = sep[1].length;
  const sepLen = sep[2].length;
  const after = head.slice(leadLen + sepLen);
  if (after.replace(/[。．！？!?\s]/g, "").length < 6) return text;
  // 冒号切点后若直接是引语（"X说：「…」"），切开会得到秃句"X说。"——不切。
  if ((sep[2] === "：" || sep[2] === ":") && /^[“"'「『]/.test(after)) return text;
  // head 从文本 0 位置开始，偏移即全文偏移（首段即开头）
  return text.slice(0, leadLen) + "。" + text.slice(leadLen + sepLen);
}

// 论点原义出口自检用的文本工具（2026-09）。
// 功能字表只收汉语【封闭词类】（助词/系词/介词/连词/代词/常见副词），不含任何领域词、
// 案例词、别名——对任意话题一视同仁，留下的永远是"用户自己写的内容字"。
// 含否定词不/没/别：它们黏在内容词尾会切出"买金豆不"这种残片（实测误报来源），一并去掉；
// 代价是否定词本身不计入比对（真正的正反颠倒由评测端的原义词命中与事实门另行兜住）。
const FN_CHARS =
  "的了得着过吗呢啊呀吧呗就而被把和与及对为在很都也还而且但并因所以其实这那个们让给从才又再最太挺来去是不没别";
const FN_ONLY_RE = new RegExp("^[" + FN_CHARS + "]$");
const PUNCT_ONLY_RE = /[\s，,。．！？!?、；：:""''（）()「」【】《》—\-]/;
const PUNCT_SPLIT_RE = /[\s，,。．！？!?、；：:""''（）()「」【】《》—\-]+/;
const FN_SPLIT_RE = new RegExp("[" + FN_CHARS + "]+", "g");

// 判据是【用户植入框里的内容片段是否还在稿里】，逐片段判。
// 基准只取植入框（embed），绝不取 intent.thesis——后者是分类器"用用户原义重述"的产物
// （见 scriptIntent.ts 提示词），拿它当基准会把用户没写过的字当成"用户原话"要求成稿照办
// （实测用户写"BL火"、重述成"BL之所以火"，切出残片"BL之"被当成丢失，触发率虚高到 56%）。
// 换成植入框后切出来的都是用户自己写的实义片段（例：BL火 / 低龄 / 魔怔人多 / 喜欢BL /
// 女生 / 双倍爱男），残片消失，触发率实测降到 13%（前身口径）。
// 为什么逐片段而不是只量覆盖率：评测端的契约就是逐词（mustContainThesis，critical），
// 实测丢一个"魔怔"时整句覆盖率仍有 89%，覆盖率线拦不住，必须逐片段判。
// 为什么不用梗概框：梗概框是"想怎么讲"的提纲，前端的「润色梗概」还会把它交给模型改写后
// 回填，本就不该要求原词复现，意思一样即可，而"意思一样"代码判不了，就不插手。
// 触发线取【丢 1 个片段就补】。评测端 mustContainThesis 是逐词 hard 检查（丢任一词即门禁
// FAIL，实测门禁真抓到过只丢"魔怔"一个词就挂），故自检口径必须对齐到逐词。轻改写已被
// BIGRAM_KEEP_RATIO=0.5 吸收（用户写"BL火"、成稿写"BL比BG火"，bigram 命中 50% 算还在），
// 不会误触发；只有整词真丢了（命中<50%）才计入 missing，正是该补写一次的。
const THESIS_FIX_MIN_MISSING = 1;

// 用户植入框里的实义片段：先按标点切，再按功能字切，只留长度≥2 的连续内容串。
// 拉丁字母统一小写：中文稿里混的英文/缩写大小写不是内容（实测用户写"bl妹"、初稿写"BL妹"
// 被判成"丢失"），归一化后两边同口径。
function embedChunks(text: string): string[] {
  return String(text || "")
    .split(PUNCT_SPLIT_RE)
    .flatMap((seg) => seg.split(FN_SPLIT_RE))
    .filter((x) => x.length >= 2)
    .map((x) => x.toLowerCase());
}

// 比对用归一化：去标点空白 + 去功能字 + 拉丁字母小写。两边同口径，允许"魔怔的人多"对上
// "魔怔人多"（模型插虚词不算改原义），与评测端 mustContainThesis 的归一化思路一致。
function coreOf(s: string): string {
  return String(s || "")
    .split("")
    .filter((c) => !PUNCT_ONLY_RE.test(c) && !FN_ONLY_RE.test(c))
    .join("")
    .toLowerCase();
}

// 片段是否算"还在稿里"：整段直接命中当然算；模型也常在词中间插字（实测"年轻人买金豆"
// →成稿写"年轻人扎堆买金豆"），纯子串比对会误判成丢失，故退一步按相邻二字组的命中比例判。
// 线取【一半】（0.5）：判据口径是"大概还在就行，不要求一模一样"——用户写"BL火"、成稿写
// "BL比BG火"（bigram 命中 BL 一条 = 50%）算在；整片被换掉则比例必然崩。纯字符串运算，无模型参与。
const BIGRAM_KEEP_RATIO = 0.5;
function chunkKept(chunk: string, coreScript: string): boolean {
  if (chunk.length < 2) return true;
  if (coreScript.includes(chunk)) return true;
  const grams: string[] = [];
  for (let i = 0; i + 1 < chunk.length; i++) grams.push(chunk.slice(i, i + 2));
  if (!grams.length) return true;
  const hit = grams.filter((g) => coreScript.includes(g)).length;
  return hit / grams.length >= BIGRAM_KEEP_RATIO;
}

// 万能尾巴修剪：模型常在已写出真实提问后再赘一句"你觉得呢？/评论区聊聊"。
// 仅当结尾前面已有一个真实问号时才剪（避免剪成秃尾），剪掉后保留原问号收尾。
function trimGenericTail(text: string): string {
  if (!text) return text;
  // 后置断言：前一个有效字符必须是问号（说明真提问已经写完），只剪赘尾、不吞问号。
  const tailRe =
    /(?<=[？?])[，,。．！？!?\s]*(?:你觉得呢|你怎么看|大家怎么看|各位怎么看|评论区(?:里|中)?(?:聊聊|说说|讨论一下|告诉我|打出来)|欢迎在评论区(?:留言|讨论))[。．！？!?\s]*$/;
  if (!tailRe.test(text)) return text;
  return text.replace(tailRe, "").trim();
}

// 碎句成段（2026-09 评测实证）：30秒稿模型常把每句单独换行写成"字幕碎句"（prompt
// 已禁但仍偶发）。若所有非空行都是一句一行的短行（中文<40字），直接拼成一个自然段；
// 只要存在真正的自然段（含多句、较长），就保留模型的分段不动。
function joinShatteredLines(text: string): string {
  if (!text || !text.includes("\n")) return text;
  const lines = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 3) return text;
  if (lines.every((l) => cnChars(l) < 40)) {
    return lines.join("");
  }
  return text;
}

// 口播稿后处理统一入口：年龄守卫之外的所有确定性清洗都走这里，主稿与扩写稿同口径。
// 返回 hookDropped：本轮是否删除过钩子位伪引语——调用方据此决定要不要按档下限触发展写。
function applyScriptGuards(
  script: string,
  factSource: string
): { text: string; hookDropped: boolean } {
  let out = fixNumberDrift(script, factSource);
  out = redactUngroundedPrices(out, factSource);
  out = dropUngroundedHistory(out, factSource);
  out = dropUngroundedDurations(out, factSource);
  out = dropDegenerateClauses(out);
  // 伪引语守卫（2026-09 健身房案）：钩子位无出处直接引语整段删、正文位去引号降级。
  // 必须在 AI 腔黑名单替换【之前】跑——黑名单词若出现在引号内被替换，会破坏引语原貌
  // 导致出处误判；也必须在断句之前跑（先拿掉伪造钩子，再对真正的首句做断句手术）。
  const quoteRes = guardQuotes(out, factSource);
  out = quoteRes.text;
  out = out
    .replace(
      /你有没有发现|你发现没(有)?|但你以为这就完了[??]?|听懂没[??]?|注意到了吗[??]?|说白了|我告诉你/g,
      ""
    )
    // 万能站队结尾：prompt 已禁，模型偶尔照犯，出口处做中立替换（保留提问结构，不删互动）
    .replace(/你站(在)?哪(一)?边[?？]?/g, "你怎么选？")
    .replace(/[，,——\-]*你支持谁站队[?？]?/g, "你怎么选？")
    .replace(/([，,：:]){2,}/g, "$1")
    .replace(/^[，,。.\s]+/, "");
  out = joinShatteredLines(out);
  out = breakLongFirstSentence(out);
  out = trimGenericTail(out);
  const text = out
    .replace(/\n{3,}/g, "\n\n")
    // 句末标点叠床架屋（2026-09 实测观点稿结尾"你怎么选？。"）：问号/叹号已结束句子，
    // 后面的句号删掉；重复句点归一。纯出口标点清洗，不动文字。
    .replace(/([？?!！])[。.．]+/g, "$1")
    .replace(/。{2,}/g, "。")
    .trim();
  return { text, hookDropped: quoteRes.dropped > 0 };
}

// 空资料兜底：脚本需要事实依据，report 为空时先联网检索话题，把真实摘要作为依据注入，
// 避免模型凭记忆写人物/战队/公司等事实细节（与 chat 路由 entity 预取同源）。
// 检索升级（2026-09 排雷）：此前只有单路 searxSearch（general 不限时）——比 chat/detail
// 的检索链降级一整截：没有并集（近30天/新闻/视频），也没有微博/贴吧/知乎平台内路
// （粉丝向讨论/最新进展大多在平台内）。升级为 searx 四路并集 + 自建爬虫双路并行，
// URL 去重合并；两路内部均静默降级，不影响脚本主流程。
type FactHit = { title: string; url: string; content: string; published?: string };

// 事实补搜：searx 四路并集 + 自建平台爬虫，URL 去重。返回结构化命中——
// 调用方既能拼快照块，也能拿 URL 去抓全文（旧版只返回拼好的文本，全文管道接不上）。
async function searxFactHits(query: string, limit = 8): Promise<FactHit[]> {
  if (!query) return [];
  const [hits, crawlerHits] = await Promise.all([
    searxSearchUnion(query, { limit, safesearch: 0 }).catch(() => []),
    crawlerSearch(query, { limit: 6 }).catch(() => []),
  ]);
  const merged: FactHit[] = [];
  const seen = new Set<string>();
  for (const h of [...(hits as any[]), ...(crawlerHits as any[])]) {
    const url = String(h?.url || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    merged.push({
      title: String(h?.title || "").trim(),
      url,
      content: String(h?.content || "").trim(),
      ...(h?.published ? { published: String(h.published) } : {}),
    });
  }
  return merged.slice(0, limit + 4);
}

async function searxFactBlock(query: string, limit = 8): Promise<string> {
  const merged = await searxFactHits(query, limit);
  return merged
    .map((h, i) => `【来源${i + 1}】${h.title}｜${h.content}`.trim())
    .filter((s: string) => s.length > 6)
    .join("\n");
}

// 出生日期探测（2026-09 年龄口径根治·泛化）：人物稿年龄写错的根因是"守卫没米下锅"——
// 报道/素材卡里通常没有出生日期，fixAgeClaims 拿不到真相只能空转，模型记忆里的过时年龄
// （"18岁的人"）原样进稿。这里与正文生成【并行】探一路「主体名+出生」检索（零额外延迟），
// 只把命中出生信息的内容并进年龄守卫的资料源。只收出生相关行：避免把旧帖的过时年龄
// 断言（"18岁的他…"）一并带入干扰守卫判定。
// 双语双查询（2026-09 实测修正）：只搜「出生」会空转——人物生日的最大来源是英文资料页
// （Liquipedia/Wikipedia，"(born July 20, 2005)"），中文查询根本搜不到它；而中文社区里
// 能搜到的多是过时年龄断言。改为「出生 + born」两路并行（与正文生成并行，不增延迟），
// URL 去重合并。失败/超时返回空串，不影响主流程。
async function probeBirthBlock(entity: string): Promise<string> {
  if (!entity) return "";
  try {
    const [zh, en] = await Promise.all([
      searxSearchUnion(`${entity} 出生`, { limit: 8, safesearch: 0 }).catch(
        () => []
      ),
      searxSearchUnion(`${entity} born`, { limit: 8, safesearch: 0 }).catch(
        () => []
      ),
    ]);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const h of [...(zh as any[]), ...(en as any[])]) {
      const t = `${h?.title || ""} ${h?.content || ""}`
        .replace(/\s+/g, " ")
        .trim();
      const u = String(h?.url || "");
      if (!t || !/出生|生于|出世|born\s|birthday/i.test(t)) continue;
      if (u && seen.has(u)) continue;
      if (u) seen.add(u);
      lines.push(t.slice(0, 160));
      if (lines.length >= 4) break;
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// 各脚本题材的形式要求，让生成结果贴合对应形态且保持简短。
// 口播稿旧指南会直接给出"你发现没""说白了"这类示例口语词——被模型逐词复读成 AI 腔
// （每份稿子共享同一套口头禅），已全部删除，改为禁令式「网感硬纪律」（与 chat 路由共享）。
const TYPE_GUIDE: Record<string, string> = {
  口播稿: `形式为「口播稿」：一段可直接对着镜头照读的口语文案。

【结构】严格按下方【本篇结构安排】指定的钩子方式开场（第一句≤20字、3秒出头念完，背景第二句再补），不要每次都用同一种开头；中间按事件推进，把信息点按重要度排布成2-3个起伏，90秒以上的稿子在约一半处必须安排一个来自资料的转折/加码/新角度做"二次钩子"，不许从头到尾平铺；结尾只保留【一个】收束动作，严格采用指定的收束方式，且必须来自资料里真实存在的争议点、反差或悬念——资料里没有争议就用事实悬念或干脆事实收尾，禁止万能套话（"你站哪边""评论区告诉我""站队""你怎么看""你觉得呢""评论区聊聊"等一律不许出现）。

${ANTI_AI_RULES}

【形式】通篇是可连续读出来的口播文字，不要小标题和分段标题，不要写"镜头/画面/BGM"等分镜提示（那是分镜脚本干的）。30秒短稿一整段；更长的稿子按内容层次分成2-4个自然段，换行只出现在段与段之间，【严禁】把每一句话单独换一行写成字幕碎句——这是用来照读的稿子，不是字幕分条。`,
  情景演绎: `形式为「情景演绎」：给出可拍摄的分镜/对白脚本。请分镜头列出，每个镜头包含：场景（地点/氛围）、人物、台词或旁白、关键动作或表情。台词要口语化、有冲突或反转，服务于把热点讲清楚讲有趣，不要平铺直叙。`,
  AI生视频: `形式为「AI生视频」：按镜头给出可直接投喂 AI 生视频工具的画面描述。每个镜头包含：画面内容（主体/场景/光线/风格）、运镜方式、字幕或旁白文字。画面描述要具体可视化，避免抽象词，方便逐镜生成。`,
};

// 目标发布平台的语感差异（发布平台≠热榜来源；前端暂无选择UI，未传默认抖音）。
// 同一条稿子发抖音和B站语感应当不同，之前完全没有受众设定。
const TARGET_TONES: Record<string, string> = {
  抖音:
    "目标发布平台：抖音。节奏最快：前3秒必须出炸点，句子短、情绪外放；但仍按自然段成段表达，不许一句一行。",
  B站: "目标发布平台：B站。允许适度玩梗和吐槽，信息密度可以更高，但观众反感营销腔与标题党式呼喊。",
  快手: "目标发布平台：快手。口语最重，直接跟观众对话，接地气。",
  小红书: "目标发布平台：小红书。第一人称分享口吻，情绪细腻，少喊口号。",
  视频号: "目标发布平台：微信视频号。表达稍收敛，少用生僻梗，兼容更广年龄层观众。",
};

// 结构轮换（2026-09 同质化评测后加入）：同题两版实测开头/结尾/结构几乎一致——
// LLM 在固定铁律下必然收敛到同一个"最典型模板"（模式崩溃），光靠禁令只会压得更窄。
// 解法是在【结构机制层】给每次请求轮换指定开场钩子与收束方式：选项全部内容中立，
// 不含任何领域词/案例词（用户铁律），只规定"怎么讲"；事实取材仍只能出自资料。
const HOOK_STYLES = [
  "数字事实钩：用事件里最有冲击力的一个具体数字或事实开场（整句≤20字），其他背景第二句再补",
  "原话现场钩：用当事人一句原话或现场一句反应开场（原话必须资料里有原句），第二句再交代是谁、在什么情况下说的",
  "反差悬念钩：用一个反常事实开场（本来会是A，结果却是B），先不给完整解释，让观众带着疑问往下听",
  "人物处境钩：从事件里一个具体的人当下的处境或选择开场，再拉开讲整个事件",
];
const END_STYLES = [
  "具体二选一追问：基于资料里真实存在的争议点，给出两个具体、对立的走向让观众选，问题必须具体到这件事，不许用泛泛问法",
  "事实悬念收束：不提问，用资料里真实未决的后续节点收尾（接下来会怎样/下一次会如何），把悬念留给观众",
  "处境代入提问：把问题抛给遇到同样处境的观众，用贴着本事件的具体场景提问（换作是你会怎么处理），不许泛泛",
  "事实点到为止：不安排提问，用一句最有分量的事实或当事人原话干脆收尾（适合争议不明、信息还不全的题材）",
];

// 观点稿中段论证弧轮换（2026-09 治同质化）：钩子/收束已有轮换，但中段此前永远是
// "立靶子→层层递进→反方"同一个爬坡形状，每篇都写出"第一层/第二层"。这里给三种
// 内容中立的论证弧（只规定怎么讲，不含任何领域词/案例词），事实取材仍只许出自资料。
// 每种弧都保留：论点锋利、论证占一半以上、反方最强版本、论证手法多样这四条内核。
const OPINION_ARCS: { name: string; body: (n: number) => string }[] = [
  {
    name: "爬坡深挖型",
    body: (n) =>
      `2. 立靶子：先讲清流行看法或对立面怎么说，再亮出上面的中心论点——冲突本身就是留人点。
3. 递进论证（占全稿一半以上篇幅）：${n}个分论点从表到里层层推进（现象→原因→更深一层的机制），段落顺序不能互换；每个分论点按"一句小论点开头 → 论证 → 一句点题"展开。`,
  },
  {
    name: "逐项算账型",
    body: () =>
      `2. 立靶子：先讲清流行看法或对立面怎么说，再亮出上面的中心论点。
3. 算账式论证（占全稿一半以上篇幅）：不要层层拔高，改成把这件事里各方实际付出与得到的代价、成本、风险一笔一笔摆清楚，至少摆三笔，笔与笔之间换角度而不是堆高度；每摆一笔立刻点一句"这笔账说明了什么"。`,
  },
  {
    name: "具体人拉大型",
    body: (n) =>
      `2. 先不要急着亮论点：从事件里一个资料中真实存在的具体人（当事人/处境相同的人）当下的处境开场，让观众先看见他在面对什么，再顺势亮出中心论点。
3. 拉大型论证（占全稿一半以上篇幅）：围绕"这个处境为什么不是他一个人的事"展开，${n}次把视野从这个人拉大到更广的背景；每拉大一次、讲完一个层次，都必须立刻切回这个人的具体处境，不许一去不回。`,
  },
];

// 相关性打分：文本（标题+摘要）与话题的 2-gram 重合数（完整命中额外加权）。
// 与 detail/route.ts 内同名函数同口径，供全文抓取的选源排序用。
function relevanceScore(text: string, topic: string): number {
  const t = text.replace(/\s+/g, "");
  const kw = topic.replace(/\s+/g, "");
  if (kw.length < 2) return t.includes(kw) ? 1 : 0;
  let score = 0;
  const seen = new Set<string>();
  for (let i = 0; i + 2 <= kw.length; i++) {
    const g = kw.slice(i, i + 2);
    if (seen.has(g)) continue;
    seen.add(g);
    if (t.includes(g)) score += 1;
  }
  if (t.includes(kw)) score += 2;
  return score;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // 绑定本请求的 LLM 配置（强制 BYOK：访客自带 Key；仅内部调用可用系统 Key）
    setRequestLlm(resolveRequestLlm(body?.llm, isInternalRequest(req)));
    if (!getLlm().apiKey) {
      return NextResponse.json(
        {
          script: "",
          error:
            "未配置模型密钥：请在「⚙️ 设置 → 🤖 AI 模型」填写 API Key，或联系管理员配置系统默认 Key。",
        },
        { status: 500 }
      );
    }
    const action: string = body?.action || "generate";
    const topic: string = (body?.topic || "").toString().trim();
    const platform: string = (body?.platform || "").toString().trim();
    const report: string = (body?.report || "").toString().trim();
    const type: string = (body?.type || "口播稿").toString().trim();
    // 联想增强手动档（2026-09）：仅口播稿 generate 且用户在弹窗主动开启时生效；
    // 最终是否真的启用还要看意图分类——只有观点稿才走联想（资讯稿不发散结构议题）。
    const associateWanted: boolean = body?.associate === true;
    // 联想两步交互：propose-associations 返回的方向卡由前端原样回传，连同用户勾选一起
    // 送进 generate。客户端数据不可信，这里按与发散端相同的形态限制重新清洗（只挡畸形/超长，
    // 内容是用户自己输入的延伸，不做领域判断）；renderSelectedBlock 内部还会二次过闸门。
    const sanitizeAssociationPlan = (raw: unknown): AssociationAxis[] | null => {
      if (!Array.isArray(raw)) return null;
      const clean = (v: unknown, max: number): string =>
        String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const cleanQueries = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.map((x) => clean(x, 40)).filter((q) => q.length >= 4).slice(0, 2)
          : [];
      try {
        const axes: AssociationAxis[] = [];
        for (const item of raw.slice(0, 3)) {
          if (!item || typeof item !== "object") return null;
          const o = item as Record<string, unknown>;
          const id = clean(o.id, 8);
          if (!/^a\d+$/.test(id)) return null;
          const kind = clean(o.kind, 12) as AssociationAxis["kind"];
          if (kind !== "data" && kind !== "precedent" && kind !== "explanation") return null;
          const axis = clean(o.axis, 30);
          const reason = clean(o.reason, 80);
          if (axis.length < 2 || reason.length < 4) return null;
          if (kind === "explanation") {
            const stances = (Array.isArray(o.stances) ? o.stances : [])
              .slice(0, 3)
              .map((s) => {
                if (!s || typeof s !== "object") return null;
                const so = s as Record<string, unknown>;
                const sid = clean(so.id, 12);
                const stance = clean(so.stance, 20);
                const sReason = clean(so.reason, 80);
                const queries = cleanQueries(so.queries);
                if (!new RegExp(`^${id}-s\\d+$`).test(sid) || stance.length < 2 || sReason.length < 4 || !queries.length)
                  return null;
                return { id: sid, stance, reason: sReason, queries };
              })
              .filter((s): s is NonNullable<typeof s> => s !== null);
            if (stances.length < 2) return null;
            axes.push({ id, kind, axis, reason, stances });
          } else {
            const queries = cleanQueries(o.queries);
            if (!queries.length) return null;
            axes.push({ id, kind, axis, reason, queries });
          }
        }
        return axes.length ? axes : null;
      } catch {
        return null;
      }
    };
    const associationPlan = sanitizeAssociationPlan(body?.associationPlan);
    const sanitizeAssociationSelection = (
      raw: unknown,
      plan: AssociationAxis[]
    ): AssociationSelection | null => {
      if (!raw || typeof raw !== "object") return null;
      const o = raw as Record<string, unknown>;
      if (!Array.isArray(o.axisIds)) return null;
      const validIds = new Set(plan.map((a) => a.id));
      const axisIds = (o.axisIds as unknown[])
        .map((x) => String(x ?? ""))
        .filter((x) => validIds.has(x))
        .slice(0, 3);
      const stanceByAxis: Record<string, string> = {};
      if (o.stanceByAxis && typeof o.stanceByAxis === "object") {
        for (const a of plan) {
          if (a.kind !== "explanation" || !axisIds.includes(a.id)) continue;
          const sid = String((o.stanceByAxis as Record<string, unknown>)[a.id] ?? "");
          if ((a.stances || []).some((s) => s.id === sid)) stanceByAxis[a.id] = sid;
        }
      }
      return axisIds.length ? { axisIds, stanceByAxis } : null;
    };
    const associationSelection = associationPlan
      ? sanitizeAssociationSelection(body?.associationSelection, associationPlan)
      : null;
    // 方向卡预取证缓存的一次性 token（propose-associations 下发）：generate 凭它取回
    // 用户当时看到的同一批已验真证据，不信任客户端回传的事实文本。
    const associationToken =
      typeof body?.associationToken === "string"
        ? body.associationToken.toString().trim().slice(0, 24)
        : "";
    const duration: string = (body?.duration || "").toString().trim();
    const wordRange: string = (body?.wordRange || "").toString().trim();
    // 领域串（可能是"影视娱乐、财经理财"这种多领域），用于从爆款库里收窄候选模板。
    // 前端未传时按全库候选处理，仍能按相关性排出最贴的几条。
    const domain: string = (body?.domain || "").toString().trim();
    // 参考梗概 / 待植入元素：一稿多发与普通脚本两条分支都要用，
    // 必须在 multi 分支之前声明（模板字符串里就引用了它们）
    const script: string = (body?.script || "").toString().trim();
    const embed: string = (body?.embed || "").toString().trim();
    // 写稿意图分类（与事实管道/模板召回并行，零串行延迟）：用户的主张可能写在梗概框、
    // 植入框，或先经"润色"被磨平——旧机制只数梗概框字数，主张填错框就漏判成资讯稿
    // （2026-09 实锤：观点被当植入梗塞进资料流水账）。改由内容中立的言语行为分类决定
    // 走观点稿还是资讯稿；multi 不需要分类（省一次调用）；失败 fail-open 回退字数启发式。
    const splitEmbed = (s: string) =>
      s
        .split(/[；;\n]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    const intentP: Promise<ScriptIntent | null> =
      action !== "multi" && type === "口播稿"
        ? classifyScriptIntent({ plot: script, embed }, callLLM)
        : Promise.resolve(
            action === "multi"
              ? null
              : ({
                  mode: "info",
                  thesis: "",
                  embedBits: splitEmbed(embed),
                } as ScriptIntent)
          );
    // 主体（人物/事物/事件）名：主体结构的方向区条目生成脚本时会带上所属主体，
    // 脚本必须以主体本身为核心展开，当前选题只是切入视角
    // 入防线（2026-09）：与 detail 同口径，叙事残段（"已核实资料显示"类）直接清空，
    // 否则补搜词会被污染成"已核实资料显示 出生/近况"（服务器日志实锤）。
    const entity: string = sanitizeEntityCandidate(
      (body?.entity || "").toString()
    );
    // 目标发布平台（默认抖音）：决定语感节奏，与热榜来源 platform 是两回事
    const target: string = (body?.target || "抖音").toString().trim();
    // 详情面板抓到的热梗/事实清单：前端"一键生成"时自动随请求带上（用户手动点chip
    // 植入走 embed，与此不冲突）。入口按数组规整，防 undefined/脏数据上游炸 500。
    const toStrArr = (v: unknown): string[] =>
      Array.isArray(v)
        ? (v as unknown[])
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((x) => x.trim())
            .slice(0, 8)
        : [];
    const memes: string[] = toStrArr(body?.memes);
    const facts: string[] = toStrArr(body?.facts);
    // 详情面板召回的真实参考链接（含搜索快照）：写稿前按相关度选源、抓全文
    const parseSites = (v: unknown): ArticleLink[] =>
      Array.isArray(v)
        ? (v as unknown[])
            .filter(
              (x): x is Record<string, unknown> =>
                !!x && typeof x === "object" && typeof (x as any).url === "string"
            )
            .map((x) => ({
              title: String(x.title || "").trim(),
              url: String(x.url).trim(),
              ...(typeof x.snippet === "string" && x.snippet.trim()
                ? { snippet: x.snippet.trim().slice(0, 150) }
                : {}),
              ...(typeof x.source === "string" && x.source.trim()
                ? { source: x.source.trim() }
                : {}),
              ...(typeof x.date === "string" && x.date.trim()
                ? { date: x.date.trim() }
                : {}),
            }))
            .filter((l) => /^https?:\/\//i.test(l.url))
            .slice(0, 10)
        : [];
    const inSites: ArticleLink[] = parseSites(body?.sites);
    if (!topic) {
      return NextResponse.json({ script: "", error: "缺少热点信息。" }, { status: 400 });
    }
    // 详情事实门闸住时，前端可能把"没有找到…直接相关的公开资料"这句提示语当 report 传来。
    // 它不是事实资料：识别出来丢弃，改走本接口自己的补搜+抓全文（零资料小作文的根源洞）。
    const PLACEHOLDER_RE = /^没有找到与「[\s\S]{0,80}」直接相关的公开资料/;
    const realReport = PLACEHOLDER_RE.test(report) ? "" : report;
    if (realReport !== report) {
      console.warn("[script] 检测到占位提示语 report，已丢弃并改走实时检索抓取:", topic.slice(0, 40));
    }

    const typeGuide = TYPE_GUIDE[type] || TYPE_GUIDE["口播稿"];
    // 目标平台语感：只有口播稿这类成稿形态需要受众设定，分镜类不区分
    const toneGuide = TARGET_TONES[target] || TARGET_TONES["抖音"];
    // 时长档位存在时，长度以该时长/字数为准（覆盖题材要求里的固定字数），否则保持简短。
    // 实测教训：相对说法（"不超过上限110%"）模型不理会（270-330字档生成过487字），
    // 必须从 wordRange 解析出具体数字写成验收标准。信息取舍是【条件式】的：字数放得下就
    // 尽量多保留（用户可自选长档位，信息密度是优点），只有明显放不下才舍弃次要信息点。
    const wrMatch = wordRange.match(/(\d+)\s*[-~至到]\s*(\d+)/);
    // prompt 字数要求写【档位中位字数】（用户拍板）：如 270-330 → "约300字左右"。
    // 实测教训：写区间（哪怕是"验收区间"措辞）模型仍 0/3 直达；写区间上限×1.1 当硬上限
    // 直达率好但违背"prompt只说标准字数"。中位字数=单一具体目标，最直观。
    // capWords 压缩线仅作代码侧兜底（最低档上限120%，其余110%），prompt 不提。
    const upper = wrMatch ? Number(wrMatch[2]) : 0;
    const lower = wrMatch ? Number(wrMatch[1]) : 0;
    let midWords = wrMatch
      ? Math.round((Number(wrMatch[1]) + upper) / 2)
      : 0;
    let capWords = upper ? Math.ceil(upper * (upper <= 150 ? 1.12 : 1.1)) : 0;
    // 产品红线=档位上限+20%（用户字数纪律）。capWords 是内部软压线（更早触发、更严），
    // redLine 是绝对线：软压后落在两线之间即收（容忍区），只有超 redLine 才二次压。
    const redLine = upper ? Math.ceil(upper * 1.2) : 0;
    let lengthGuide =
      duration && wordRange
        ? `目标视频时长约${duration}，脚本总字数（含标点）约 ${midWords || wordRange} 字左右（口播稿即口播文字量；分镜类脚本请让全部台词/旁白/画面描述的文字总量贴近该字数），请贴合该时长与字数，不要明显偏短或偏长。`
        // 无时长档位时原指令是"篇幅务必简短精炼"，实测模型会把它执行成 175 字的提纲式
        // 残稿（2026-09 评测）。口播成稿给具体字数锚点：约 500 字、信息充实。
        : action === "generate"
          ? `目标发布平台${target || "短视频"}：口播成稿总字数（含标点）约 500 字左右，开头钩子、事件信息点、各方反应、结尾互动都要写完整，不要明显偏短。`
          : "篇幅务必简短精炼，不要冗长。";
    // 过短兜底阈值（2026-09 评测）：有字数档位时按档位中位 60% 兜底；无档位口播稿按 300 兜底。
    let minWords = midWords ? Math.round(midWords * 0.6) : 300;
    // 字数终检块放在 prompt 最末尾（模型对末尾指令遵循度最高），只写中位字数目标。
    // 素材量不足触发自动降档时（见下方资料管道），这几个值会被重算、capTail 随之重建。
    let capTail = capWords
      ? `\n【字数终检·动笔前先做】全稿约 ${midWords} 字（含标点）。先估一下资料信息量：放得下就尽量多保留信息；明显放不下，就按"最炸程度"挑出最值得讲的 2-3 个信息点，其余果断舍弃。写完自己数一遍字数，超了就删整句压缩，不要缩写成书面语。`
      : "";
    // 观点评论稿模式（2026-09 用户实测问题根治）：用户在故事梗概里写下自己的判断/态度
    // （≥12个非空白字）时，本条是"观点口播"，不是资讯播报。两个根本差异：
    //  ①时长由"中心论点 × 论证层次"撑住，不由抓取资料条数决定——观点稿的信息量=
    //   论点数量×论证深度，薄素材加强观点照样能撑满长档。旧逻辑纯按资料字数折算支撑秒数，
    //   用户实测选3分钟档被自动砍成60秒。故观点模式【关闭自动降档】，并改写字数指引；
    //  ②资料是论据库不是播报稿——生成 prompt 走独立观点稿模板（见下方生成分支），
    //   禁止按时间线复述帖子，用户梗概是全稿中心论点、不得中立化。
    // 观点模式由【意图分类】决定（主张写在梗概框或植入框都认），不再看框位置/字数。
    const intent = (await intentP) ?? heuristicIntent({ plot: script, embed });
    const opinionMode = type === "口播稿" && intent.mode === "opinion";
    // 全稿中心论点（原义保真，观点稿 prompt 以此为唯一主线）；
    // embedMaterial 是分类后剩下的"素材/梗"部分（主张已被提走，不会再被当植入梗）。
    const centerThesis = intent.thesis;
    const embedMaterial = intent.embedBits.join("；");
    // ── 联想两步交互·第一步：只发散 + 预取证，返回方向卡数据（不跑全文资料管道、不写稿）──
    // 非观点稿直接给空轴，前端按普通稿继续；任何失败 fail-open 返回空轴。
    if (action === "propose-associations") {
      const intentLite = { mode: intent.mode, thesis: centerThesis };
      if (!opinionMode) {
        return NextResponse.json({ ok: true, intent: intentLite, axes: [] });
      }
      try {
        const axes = await proposeAssociationAxes(topic, centerThesis, callLLM);
        await gatherProposalEvidence(axes, callLLM);
        // 已验真事实只存服务端内存，下发方向卡前剥掉 verifiedFacts，另发一次性 token；
        // generate 凭 token 取回同一批证据，杜绝二次检索波动静默丢掉用户勾选。
        const proposalToken = rememberProposal(axes, topic);
        return NextResponse.json({
          ok: true,
          intent: intentLite,
          axes: toPublicAxes(axes),
          proposalToken,
        });
      } catch (e) {
        console.warn("[association] propose 失败，前端应回退普通稿:", (e as Error)?.message || e);
        return NextResponse.json({ ok: true, intent: intentLite, axes: [] });
      }
    }
    // 联想增强（手动档）：
    // · 两步流（方向卡）：前端回传 plan+勾选 → 只对选中方向重新取证（命中预取证缓存）渲染证据块；
    // · 一步兜底（测试直调/老客户端只给 associate:true）：发散→取证→默认选择全自动。
    // 此刻立即启动，与全文抓取/模板召回/RAG 并行，不增加串行墙钟；没取到证据返回空块，
    // 按普通观点稿写（不阻塞、不报错）。
    const associationP: Promise<AssociationResult | null> =
      associateWanted && action === "generate" && opinionMode
        ? (async () => {
            // 核对服务端缓存轴与客户端回传方向卡的形状（id/种类/成因方向 id）是否一致：
            // token 可能张冠李戴或被重放配别的方向卡，形状不符就当缓存未命中处理。
            const cachedAxesMatchPlan = (
              cached: AssociationAxis[],
              plan: AssociationAxis[]
            ): boolean => {
              if (cached.length !== plan.length) return false;
              return plan.every((p) => {
                const c = cached.find((x) => x.id === p.id);
                if (!c || c.kind !== p.kind) return false;
                if (p.kind !== "explanation") return true;
                const pIds = (p.stances || []).map((s) => s.id).sort();
                const cIds = (c.stances || []).map((s) => s.id).sort();
                return pIds.length === cIds.length && pIds.every((id, i) => id === cIds[i]);
              });
            };
            if (associationPlan) {
              if (!associationSelection) {
                return { axes: associationPlan, evidence: [], block: "", sources: [] };
              }
              // 凭 token 取回 propose 阶段已验真的完整轴；过期/重启/串题/形状不符 → null，
              // renderSelectedBlock 对缺失单元自动重新取证（fail-open）。
              const cached = associationToken
                ? recallProposal(associationToken, topic)
                : null;
              const cachedAxes = cached && cachedAxesMatchPlan(cached, associationPlan) ? cached : null;
              const planForRender = cachedAxes ?? associationPlan;
              const { block, sources } = await renderSelectedBlock(
                planForRender,
                associationSelection,
                callLLM,
                cachedAxes
              );
              return {
                axes: cachedAxes ? toPublicAxes(cachedAxes) : associationPlan,
                evidence: planForRender.filter((a) => a.gate === "pass"),
                block,
                sources,
              };
            }
            return buildAssociationMaterial(topic, centerThesis, callLLM);
          })()
        : Promise.resolve(null);
    // 联想证据块（generate 观点稿分支里赋值）：注入 prompt 的同时并入事实守卫的资料源，
    // 否则数字守卫会把联想证据里的真实数字当"无依据数字"误伤。
    let assocBlock = "";
    let association: AssociationResult | null = null;
    // RAG 命中数（generate 分支赋值；polish/multi 不检索，保持 0）——顶层声明供
    // _evalGround 探针在任意分支安全读取。
    let ragHitsCount = 0;
    if (opinionMode) {
      if (midWords) {
        lengthGuide =
          `目标视频时长约${duration}，全稿口播文字（含标点）约 ${midWords} 字左右，${capWords} 字是绝对上限（含标点，一个字都不能超）。` +
          `这是观点评论稿：篇幅靠论证层次撑足（递进分论点／反方最强观点与反驳／心理机制分析／生活类比），` +
          `【严禁】以"资料条数少、信息量不够"为由自行缩短或降档；在不超上限的前提下字数尽量写够，` +
          `但也不许把同一句话换说法重复凑字数。`;
      }
      if (capWords) {
        capTail =
          `\n【字数终检·动笔前先做】全稿约 ${midWords} 字（含标点），硬上限 ${capWords} 字。写完逐字数一遍：` +
          `超了就整句删次要的铺垫与举例（优先保中心论点、递进论证和结尾反问），不要缩写成书面语；` +
          `短了就补论证层次（再加一层递进分析／替反方多说一句再反驳／一个生活类比），不许补修辞废话。`;
      }
    }
    // 可选素材库：详情面板已核实的热梗与事实自动进入生成视野（标注"选用"，
    // 贴主线才用，防硬塞）；此前这些梗只有用户手动点chip才进 embed，直接点
    // "生成"时最有网感的素材根本没喂给模型。
    const materialBlock =
      memes.length || facts.length
        ? `\n\n【可选素材库·选用不硬塞】以下是该热点已抓取的热梗与事实清单，贴主线的自然用进稿里，不贴的忽略；梗与事实都来自资料，可放心引用但不要改写事实：\n${[
            memes.length ? `热梗：${memes.map((m) => `「${m}」`).join(" ")}` : "",
            facts.length ? `事实：${facts.join("；")}` : "",
          ]
            .filter(Boolean)
            .join("\n")}`
        : "";
    const from = platform ? `（来自${platform}热榜）` : "";
    // 主体条目：脚本/梗概/成稿都要以主体本身为核心，选题角度只是切入视角
    // 核心主体规则（2026-09 方向区补丁）：
    // 旧版说"以主体为核心、选题只是切入视角"——模型理解成"选题不重要，讲主体就好"，
    // 结果围绕主体生涯/成就/数据泛泛而谈，完全脱离用户点的具体角度（颜值/361度）。
    // 新版明确：脚本必须围绕【角度】展开（主体资料只作为背景补充），
    // 严禁脱离角度泛泛介绍主体。
    const angleOnly = entity ? topic.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim() : "";
    const entityRule = entity
      ? `\n核心主体：「${entity}」。本条视频的【核心切入角度】是「${angleOnly || topic}」——内容必须围绕这个角度展开（讨论它在这个角度下的表现/争议/特点），主体资料只作为背景补充，【严禁】脱离这个角度泛泛介绍主体本身的生涯/成就/数据。`
      : "";
    // 事实依据：有报道用报道；report 为空时联网检索一次话题兜底（有主体名时优先检索主体本身，
    // 主体资料比角度句更贴事实），检索也无结果才退回"凭常识创作"——把凭记忆写事实的风险窗口关到最小。
    // 时效基准：模型不知道"今天几号"，资料又常混有旧报道——必须锚定日期并强制以最新进展为落点，
    // 否则小众切入会出现"把去年的下放当新闻写，今年的回归/夺冠反而不提"的过时稿。
    const today = new Date().toISOString().slice(0, 10);
    const freshAnchor = `今天是 ${today}。资料中同一主体/事件若有多个时间点的进展，内容必须以【最新进展】为现状落点（旧事件只作一句"曾/此前"的过去式背景，严禁把已被新进展取代的旧状态当成现状来写）；涉及人物年龄、头衔、所在队伍等"现状"信息一律按今天的时点来写。人物当前年龄必须与资料一致：资料里有出生日期才写具体年龄（并按今天折算），资料没有的年龄数字一律不写。`;
    // 出生日期探测（与正文生成并行，零额外延迟）：只喂给年龄守卫做资料源，见 fixAgeClaims
    const birthProbeP = probeBirthBlock(entity);
    // 主体最新近况补检索（2026-09 第二轮，治"窄角度脚本用过时旧报道"）：report 非空时
    // 详情报道围绕【角度】选材，主体层面的最新进展可能被主线纪律裁掉；而口播稿的现状落点
    // 必须是"今天"（用户实测：写 2025 下放、不提 2026 回归夺冠）。与正文/模板准备并行、
    // 零额外延迟：补一路「主体 近况 最新」，追加进事实依据，声明现状冲突时以新的为准。
    const freshProbeP =
      entity && realReport
        ? searxFactBlock(`${entity} 近况 最新`, 6).catch(() => "")
        : Promise.resolve("");

    // ───────── 全文资料管道（2026-09）─────────
    // 搜索引擎只给 ≤150 字快照，写稿模型长期吃不到原文 → 长稿兑水、脑补现场。
    // 管道：详情链接（+空报道/占位时的实时补搜）→ queryPlan 算相关度 → 分桶选源
    // （权威定事实/时效进展/圈内讨论，去转载、域名限流）→ 并行抓全文 ≤5 篇，
    // 封死域/抓取失败静默退回快照 → 原文摘录 + 快照 组成事实依据。
    const plan = queryPlan(topic);
    const rankSubject = plan.main || entity || topic;
    const scoreLink = (l: ArticleLink): number =>
      relevanceScore(`${l.title} ${l.snippet || ""}`, rankSubject);
    const isFresh = (d?: string) =>
      !!d && !Number.isNaN(Date.parse(d)) && Date.parse(d) >= Date.now() - 30 * 864e5;

    const candidateMap = new Map<string, RankedLink>();
    const addCandidate = (l: ArticleLink) => {
      const prev = candidateMap.get(l.url);
      const ranked: RankedLink = {
        ...l,
        score: scoreLink(l),
        fresh: isFresh(l.date),
      };
      // 同 URL 合并：有快照的覆盖没空快照的（详情/补搜两路可能撞车）
      if (!prev || (!prev.snippet && ranked.snippet)) candidateMap.set(l.url, ranked);
    };
    inSites.forEach(addCandidate);
    // 两种情况必须实时补搜：① 前端没带链接（裸入口）② 报道缺失或是占位提示语。
    // 补搜同时根治"零资料小作文"洞——旧逻辑拿提示语当报道就跳过了这一步。
    if (inSites.length === 0 || !realReport) {
      const fallbackHits = await searxFactHits(entity || rankSubject, 8).catch(() => []);
      fallbackHits
        .filter((h) => h.title && h.url)
        .forEach((h) =>
          addCandidate({
            title: h.title,
            url: h.url,
            snippet: h.content.slice(0, 150),
            ...(h.published ? { date: h.published } : {}),
          })
        );
    }
    const ordered = planFetchOrder([...candidateMap.values()], plan.folkAsk);
    const docs = await fetchDocs(ordered, 5).catch(() => [] as Awaited<
      ReturnType<typeof fetchDocs>
    >);
    const fullDocs = docs.filter((d) => d.full);
    const docsBlock = renderDocsBlock(docs);

    // 料量估时：按口播 4.5 字/秒估算素材能支撑多长，宁可降档也不兑水凑时长。
    // 折算系数保守：原文信息到成稿有压缩（不是每个字都能念），快照信息密度高但短。
    // 报道概括（高密度事实综述）与已核实事实/热梗清单同样入料，早期版本漏算它们，
    // 导致"报道很厚但全文偏短"的题被过度降档（付航案：实测判40秒，诚实值约60秒）。
    // 观点评论稿不降档（2026-09）：用户给了明确观点梗概时，时长由论证层次而非素材
    // 条数支撑——观点稿的写作手法（推演/心理分析/类比/反方反驳）不消耗"事实素材"，
    // 按字数折算会把3分钟档误砍成60秒（用户实锤）。字数注水风险由 prompt 的论证结构
    // 要求和字数终检兜住。
    const fullCn = fullDocs.reduce((n, d) => n + d.cn, 0);
    const snipCn = docs.filter((d) => !d.full).reduce((n, d) => n + d.cn, 0);
    const reportCn = cnChars(realReport);
    const factsCn = cnChars([...facts, ...memes].join("；"));
    const supportSec = Math.round(
      (fullCn * 0.12 + snipCn * 0.35 + (reportCn + factsCn) * 0.4) / 4.5
    );
    let downgrade = "";
    const reqSec = (() => {
      const m = duration.match(/(\d+)\s*分/);
      const s = duration.match(/(\d+)\s*秒/);
      return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
    })();
    if (!opinionMode && reqSec >= 30 && supportSec > 0 && supportSec < reqSec * 0.7) {
      const effSec = Math.max(30, Math.min(reqSec, Math.round(supportSec / 10) * 10));
      const effWords = Math.round(effSec * 4.5);
      downgrade = `参考资料的信息量约够支撑 ${effSec} 秒口播（你选了约${duration}），已自动缩短成短稿，没有兑水凑时长。想做长一点，可以换个更具体的说法或稍后再试。`;
      midWords = effWords;
      capWords = Math.round(effWords * 1.12);
      minWords = Math.round(effWords * 0.6);
      lengthGuide =
        `目标视频时长约${effSec}秒，脚本总字数（含标点）约 ${effWords} 字。` +
        `资料信息量只够这个篇幅：只讲资料里真实有的信息点，【严禁】把同一件事换说法重复、` +
        `严禁加修辞水分凑字数；宁可信息密集的短稿，也不写注水长稿。`;
      capTail =
        `\n【字数终检·动笔前先做】全稿约 ${effWords} 字（含标点）。写完自己数一遍，超了就删整句，不要缩写成书面语。`;
    }

    // 本篇结构安排：每次请求随机轮换钩子/收束（治同题同构）。纯结构机制、内容中立；
    // 口播稿才需要，分镜类不加。钩子与收束独立抽取（4×4=16 种组合）。
    const pickStyle = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const hookStyle = pickStyle(HOOK_STYLES);
    const endStyle = pickStyle(END_STYLES);
    const effectiveReqSec = midWords ? Math.round(midWords / 4.5) : reqSec;
    // 观点稿中段论证弧按条轮换（3 种弧，见 OPINION_ARCS），观测字段 opinionArc 供门禁/排查。
    const opinionArcDef = pickStyle(OPINION_ARCS);
    const opinionArcName = opinionArcDef.name;
    const opinionArcMiddle = opinionArcDef.body(effectiveReqSec >= 85 ? 3 : 2);
    const structureGuide =
      type === "口播稿"
        ? `\n\n【本篇结构安排】（系统按条轮换以避免千篇一律，本条必须照用，不要自行换成别的开头/结尾套路）\n- 开头钩子：${hookStyle}\n- 收束方式：${endStyle}${
            effectiveReqSec >= 85
              ? "\n- 本篇较长：约一半处用一个资料里真实有的转折/加码/新角度形成二次钩子，避免平铺"
              : ""
          }\n结构只决定"怎么讲"，所有事实仍然只能出自上面的资料；指定钩子若在资料里找不到对应素材，就退回用数字事实钩，不许为套结构编素材。`
        : "";

    // 事实依据组装：信任级必须显式分层（2026-09 链路审计）——report 是 LLM 看搜索摘要
    // 二次综合的"概括"，不是原文；若不标注，下游写稿会把概括里可能失真的数字/引语当权威
    // 抄写。规则：综述只用于快速理解，具体数字/引语以原文摘录（其次快照）为唯一出处。
    const REPORT_TAG = `【事件综述·服务端基于多篇搜索摘要的二次概括（非原文）】以下内容只用于快速理解事件脉络；凡涉及具体数字、日期、人名机构名、引语，都必须以下方原文摘录/快照里的原句为准，综述里写了但下方资料找不到原句的，不许写进成稿：`;
    let groundBlock = "";
    if (realReport && docsBlock) {
      groundBlock = `该热点事件的事实依据如下，请以此为据，不要编造资料之外的事实。${freshAnchor}\n${REPORT_TAG}\n${realReport}\n\n${docsBlock}`;
    } else if (realReport) {
      groundBlock = `该热点事件网上相关的高热度报道如下，请以此为事实依据，不要编造报道之外的事实。${freshAnchor}\n${REPORT_TAG}\n${realReport}`;
    } else if (docsBlock) {
      groundBlock = `该热点事件网上相关的高热度资料如下（含服务端实时抓取的文章原文），请以此为事实依据，不要编造资料之外的事实；涉及具体人物/机构/数据等容易记错的细节，【只能】写资料支撑的内容。${freshAnchor}\n${docsBlock}`;
    } else {
      groundBlock = `暂无额外报道资料。${freshAnchor}\n请依据这个热点事件本身的常识来创作，不要编造具体的时间地点数字等未知细节。`;
    }
    {
      const fresh = await freshProbeP;
      if (fresh) {
        groundBlock += `\n\n【主体最新近况补充（服务端刚刚实时检索所得）】以下是「${entity}」的最新动态，涉及"现状/最新进展/当前成绩/归属"的表述与上面报道冲突时，【以这部分更新的为准】，旧状态只作过去式背景：\n${fresh}`;
      }
    }

    // 一稿多发：同一选题按平台直接成稿（小红书图文 / 公众号短文），一次返回两平台成稿包
    if (action === "multi") {
      const outline = await pickRelevantTemplates(topic, domain, 3, callLLM);
      const ref2 = outline.length
        ? `\n\n参考下面真实爆款的结构套路（只学钩子和节奏，不要抄内容与措辞）：\n\n${renderTemplateOutlines(outline)}`
        : "";
      const multiPrompt = `你是多平台内容运营。基于热点事件与相关报道，为两个平台各写一份可直接发布的成稿。
热点事件：「${topic}」${from}
${groundBlock}${entityRule}${ref2}
${script ? `\n参考梗概（保留其核心切入角度）：\n${script}` : ""}
${embed ? `\n需要自然植入的梗/台词：\n${embed}` : ""}

只返回 JSON（不要任何解释）：
{"xhs":{"titles":["3个小红书风格标题，带情绪钩子，每个不超过20字"],"cover":"封面大字文案，8字内，有冲击力","body":"小红书图文正文：首行钩子，正文短句+适量emoji，分2-3段，结尾一句互动引导，全文300字内","tags":["5-6个话题标签，每个#开头"]},"gzh":{"titles":["3个公众号标题，信息量+悬念，每个不超过22字"],"cover":"封面文案，10字内","body":"公众号短文：有观点有信息量，分3段左右，全文500字内，结尾引导在看或留言","tags":["3-4个标签，每个#开头"]}}
硬性要求：严格依据报道资料，绝不编造事实与数字；两个平台文风必须明显不同；只返回 JSON。`;
      const [raw, birthBlock] = await Promise.all([
        callLLM(multiPrompt),
        birthProbeP,
      ]);
      const m = raw.match(/\{[\s\S]*\}/);
      let pack: {
        xhs: ReturnType<typeof normPack> | null;
        gzh: ReturnType<typeof normPack> | null;
      } | null = null;
      function normPack(v: unknown) {
        if (!v || typeof v !== "object") return null;
        const o = v as Record<string, unknown>;
        const toArr = (x: unknown): string[] =>
          Array.isArray(x)
            ? x
                .filter((y): y is string => typeof y === "string")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 8)
            : [];
        const titles = toArr(o.titles);
        const body = typeof o.body === "string" ? o.body.trim() : "";
        if (!titles.length && !body) return null;
        return {
          titles,
          cover: typeof o.cover === "string" ? o.cover.trim() : "",
          body,
          tags: toArr(o.tags),
        };
      }
      if (m) {
        try {
          const obj = JSON.parse(m[0]) as Record<string, unknown>;
          pack = { xhs: normPack(obj?.xhs), gzh: normPack(obj?.gzh) };
        } catch (e) {
          console.warn("[script] 一稿多发 LLM 返回 JSON 解析失败，将走失败兜底:", (e as Error)?.message || e);
        }
      }
      if (!pack || (!pack.xhs && !pack.gzh)) {
        return NextResponse.json(
          { error: "一稿多发生成失败，请稍后重试。" },
          { status: 502 }
        );
      }
      // 年龄守卫 + AI腔清除（2026-09 补齐）：multi 分支此前直接返回，成稿里的
      // "当前年龄"旧记忆回潮与黑名单口头禅（你发现没/说白了…）不经过任何清理，
      // 与普通脚本分支的出口标准不一致。逐字段清理（不动 JSON 结构）：
      // 标题/封面/正文先做 AI 腔替换，正文再做年龄守卫（资料同源 report/facts/memes
      // + 并行探测到的出生日期资料 birthBlock——守卫有真相才能修年龄）。
      const ageSrc = [realReport, ...facts, ...memes, birthBlock]
        .filter(Boolean)
        .join("\n");
      const cleanCopy = (s: string) =>
        s
          .replace(
            /你有没有发现|你发现没(有)?|但你以为这就完了[??]?|听懂没[??]?|注意到了吗[??]?|说白了|我告诉你/g,
            ""
          )
          .replace(/你站(在)?哪(一)?边[?？]?/g, "你怎么选？")
          .replace(/[，,——\-]*你支持谁站队[?？]?/g, "你怎么选？")
          .replace(/([，,：:]){2,}/g, "$1")
          .replace(/^[，,。.\s]+/, "");
      for (const key of ["xhs", "gzh"] as const) {
        const p = pack[key];
        if (!p) continue;
        p.titles = p.titles.map(cleanCopy).filter(Boolean);
        p.cover = cleanCopy(p.cover);
        p.body = cleanCopy(fixAgeClaims(ageSrc, p.body).text);
      }
      return NextResponse.json({ pack });
    }

    let prompt = "";
    if (action === "polish") {
      const plot: string = (body?.plot || "").toString().trim();
      if (!plot) {
        return NextResponse.json({ script: "", error: "请先输入梗概内容。" }, { status: 400 });
      }
      // 梗概也调爆款库：只给「结构骨架」（选题角度/结构脉络/情绪基调/套路），
      // 不给金句和 CTA——否则模型会顺着金句把梗概写成成稿，就和脚本重复了。
      // 润色同样先识别意图（polish 请求前端只上送 plot）：观点想法一旦被"润色"成中立
      // 提纲，后面再生成就漏判成资讯稿（2026-09 事故链路之一），故观点走保锋芒口径。
      const [outlineSamples, polishIntent] = await Promise.all([
        pickRelevantTemplates(topic, domain, 3, callLLM),
        classifyScriptIntent({ plot }, callLLM),
      ]);
      const outlineRef = outlineSamples.length
        ? `\n\n以下是与该话题套路最贴的真实爆款结构拆解（只学它们的切入角度和情节走向，不要照抄内容，也不要把样例里的措辞搬进来）：\n\n${renderTemplateOutlines(outlineSamples)}`
        : "";
      prompt =
        polishIntent.mode === "opinion"
          ? `你是资深短视频编导。用户给的是一个【观点判断】，请把它整理成一段观点评论口播的【极简提纲】（不是成稿）。
热点事件：「${topic}」${from}
${groundBlock}${entityRule}${outlineRef}

用户的观点：
${plot}

要求：
1. 【篇幅】100 字左右，绝不超过 200 字，只写提纲不写台词、不展开成口播文字；
2. 提纲结构：先一句亮明核心主张（保留用户原话的锋芒，【严禁】改温和、改中立、改成"梳理/盘点一下"），再写"立什么靶子 → ${
              effectiveReqSec >= 85 ? "3" : "2"
            }个层层递进的论证角度 → 反方最有道理的那句话怎么驳 → 结尾金句/反问落点"；
3. 论证角度要能在上面资料里找到论据支撑，资料没有的硬事实不许写进提纲，但心理分析/因果推演/生活类比这类论证手法可以写；
4. 直接输出提纲正文，不要解释、标题、序号外的多余话。`
          : `你是资深短视频编导。请把用户的想法，结合下面的热点事件与相关报道，整理成一段【极简的梗概】。
热点事件：「${topic}」${from}
${groundBlock}${entityRule}${outlineRef}

用户的想法：
${plot}

要求：
1. 【篇幅硬性要求】总字数控制在 100 字左右，绝对不能超过 200 字。梗概只是一句话讲清"这条视频要怎么讲"的提纲，不是成稿；
2. 只写核心切入角度和内容走向（怎么开头、中间讲什么、落到什么观点），不要展开成可直接照读的口播文字，不要写台词；
3. 参考上面爆款样例的结构套路来定走向，但不要抄它们的内容和措辞；
4. 紧扣热点事件，保留用户想法里的核心创意，不要跑题；
5. 直接输出梗概正文，不要任何解释、前言、标题、序号或"以下是"之类的话。`;
    } else {
      // 爆款库参考改配比：语感从原文摘录学（这批全部给出），结构从拆解学（只给2条，
      // 且用不含金句/CTA的骨架版——"金句话术"字段会诱导模型改写复用样例金句）。
      // 旧的"5条拆解+1条原文片段"被证明学得到结构、学不到语感。
      // RAG 真实口播语料（本地 Qwen3 embedding+reranker，零 API 成本、与 LLM 选模板
      // 并行不增延迟）：461 条模板拆出的是"结构骨架"，RAG 里 1900+ 段 ASR 原文补的是
      // "真人语感"。此前写稿链路只用结构化模板、完全没接 RAG（只在 chat 路由用）。
      // 检索词带观点主张（观点稿）或梗概，命中更贴本轮表达姿态的原文；任何失败静默降级。
      const ragQuery = `${topic} ${opinionMode ? centerThesis : script}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      const [samples, ragHits, associationRes] = await Promise.all([
        pickRelevantTemplates(topic, domain, 5, callLLM),
        ragQuery.length >= 4
          ? retrieveVoiceCorpus(ragQuery, { topK: 3, minScore: 0.35 }).catch(() => [])
          : Promise.resolve([]),
        associationP,
      ]);
      association = associationRes;
      assocBlock = associationRes?.block || "";
      ragHitsCount = ragHits.length;
      const ragBlock = ragHits.length
        ? `\n\n${formatKnowledge(ragHits)}`
        : "";
      const outlineBlock = samples.length
        ? `\n\n以下是最贴话题的2条真实爆款结构拆解（只学结构套路，不要照抄内容与措辞）：\n\n${renderTemplateOutlines(samples.slice(0, 2))}`
        : "";
      const excerptBlock = renderExcerpts(samples);
      const voiceBlock = excerptBlock
        ? `\n\n以下是这批爆款对应的真实原文片段——语感主要从这里学：口语措辞、节奏、梗的用法（忽略语音转写产生的错别字）；严禁照抄其中的具体内容与句子：\n\n${excerptBlock}`
        : "";
      // 观点评论稿走独立模板（2026-09 根治"帖子总结腔"）：用户在梗概里给了观点时，
      // 旧模板的"所有具体事实资料没写一个字都不许补"会把模型逼成只能按时间线复述资料，
      // 观点论证（推演/心理分析/类比/反方反驳）全被自我审查掉，成品就是"贴吧日报"。
      // 新模板把【硬事实】与【观点论证】分层：前者零虚构，后者必须写足；素材定位为
      // "论据库"，一个帖子=一个证据/靶子，引完必评，严禁日期报幕。
      // 资讯稿交稿前事实倒查（观点稿已有 OPINION_FACT_BOUNDARY 同效纪律，不重复加）：
      // 2026-09 实测"拿了4年顶薪合同"被推演成"等了四年才穿上队服"，光靠前置纪律没拦住，
      // 在模型遵循度最高的末尾再压一道具体动作（数字/年份/时长逐个回对资料，找不到就删句）。
      // 信息块预算（同月实测：育儿补贴案两轮压缩都到 874 字压不动——模型生成时塞了
      // 国家/省/流程/4城加码/辟谣 5 大块，事后压缩舍不得整块砍。预算必须前置到生成阶段）：
      // 终检/时态/引语三块纪律与 chat 写稿入口共用 buildInfoFactTail，禁止两处各写各的。
      const factTail = opinionMode ? "" : buildInfoFactTail(midWords);
      prompt = opinionMode
        ? `你是靠"观点锐评"涨粉的头部短视频口播博主。观众刷到你，不是来听新闻复述，是来听你把一个有争议的判断掰开揉碎讲透。请基于【用户给出的中心论点】，写一篇可以直接对着镜头讲的观点评论口播稿。

【本条视频的中心论点·用户原话】
「${centerThesis}」
这是全稿唯一主线：你的任务是把这个判断论证清楚、讲出别人没想到的层次，不是把它复述成中立总结。论点原义必须在稿中完整保留，【严禁】稀释、偷换，【严禁】和稀泥写成"一方面…另一方面…各有各的道理"，也【严禁】因为话说得尖锐就擅自改温和、改中立。

【由头事件】「${topic}」${from}
【论据库】（注意：下面的资料是你论证的弹药，不是要你播报的内容）
${groundBlock}${entityRule}${materialBlock}${outlineBlock}${voiceBlock}${ragBlock}${assocBlock}
${embedMaterial ? `\n可以自然用上的用户指定梗/台词（用不上别硬塞）：\n${embedMaterial}` : ""}

按以下结构写（${
          effectiveReqSec >= 85
            ? "本篇较长，五个部分一个都不能省"
            : "短稿可把第4部分并入第3部分"
        }；系统会按条轮换中段的讲法以避免千篇一律，本条的论证弧必须照用；整篇直接成段口播，2-4个自然段，不要写小标题、序号或分镜提示，分论点之间靠内容本身衔接，【严禁】"第一层/第二层/第三点/首先/其次/再次"这类序号词，写在句子正文里的也算）：
1. 开头3秒：直接甩判断或反常识断言，第一句（到第一个句号/问号/感叹号为止）不超过20字，第一句就让人停下来。严禁自我介绍、"今天聊聊"、"先问大家一个问题"。${HOOK_QUOTE_RULE}；
${opinionArcMiddle}
- 论证通用要求：举例、因果推演、反问、对比、生活类比这五种手法至少用到两种；每个抽象判断后面立刻跟一个【有出处的落点】——要么是论据库里本事件的具体细节、数字或原话，要么是上方"结构联想证据"里的事实；"很多人/从小/一直以来/众所周知"这类没有出处的泛化断言一律不许写，找不到落点的判断就删掉，不许用空话撑着。
4. 反方最强版本与反驳：替反对者把他最有道理的那句话讲出来，先承认其中对的部分，再划清你不同意的地方——这比自说自话可信十倍。
5. 收尾：严格按上方【本篇结构安排】指定的收束方式结束，必须落回眼前这件事的具体人/具体场景；不许喊空泛口号、不许写格言式人生道理，也不许为了造"能截图的金句"硬凑一句听起来漂亮但没有信息量的话。

【素材使用纪律】
- 资料是证据不是菜单：一篇帖子、一个回答、一条评论，只取与当前分论点有关的一个细节、数字或心态，用"有人算过一笔账""一个高赞回答的逻辑是""网上有种说法"模糊化转述；【严禁】"X月X日某平台有个帖子说……后来又有个回答说……"这种按时间报幕、逐条总结资料的写法。
- 每用一次素材，后面必须接你自己的分析（这恰好说明了什么／问题到底出在哪），引完必评，不许素材裸奔。
- 观点论证【允许而且必须写足】：因果推演、群体心理分析、生活类比、反方假设、逻辑反驳——这些是观点稿的主体，不属于编造事实，不要因为"资料里没写"就不敢讲；但所有这类分析都必须遵守上面的"有出处的落点"要求，且资料里没有的【硬事实】（具体数字、日期、人名机构名、原话引用）一个字都不许编，拿不准的用"目前能看到的说法是"限定。
${OPINION_FACT_BOUNDARY}
- 分寸：批评现象、行为和背后的心理机制，不给身份群体扣侮辱性帽子、不攻击持观点的人。用户论点里带情绪的网络骂词，要转写成对行为与心理的分析（如把骂人群体的词改写成"这类行为背后的心理代偿是……"），保留结论的锋利、去掉对人群的侮辱；不造谣、不挑动对立。

【口语】全篇对着一个具体的"你"讲话，短句为主、长短交错，念出来不拗口；按自然段成段，不许一句一行。严禁"大家好/今天给大家/随着/综上所述/首先其次最后/值得我们深思/据悉/近日/小编/你有没有发现/说白了/我告诉你"。
${toneGuide}${structureGuide}
${lengthGuide}
直接输出口播正文，不要任何解释、前言、标题或"以下是"之类的话。${capTail}`
        : `你是资深短视频编导。请结合下面的热点事件与相关报道，生成一个对应题材的脚本。
热点事件：「${topic}」${from}
${groundBlock}${entityRule}${materialBlock}${outlineBlock}${voiceBlock}${ragBlock}
${script ? `\n参考梗概（这是本条视频的提纲，请在此基础上展开成完整脚本，保留其核心创意与走向）：\n${script}` : ""}
${embedMaterial ? `\n请尽量自然地把以下用户希望植入的梗、彩蛋、特定台词或名场面融入脚本中：\n${embedMaterial}` : ""}

要求：
1. ${typeGuide}${structureGuide}
2. ${toneGuide}
3. ${lengthGuide}
4. 紧扣上面的热点事件，并结合上面的参考梗概与需要植入的梗/台词/桥段；
5. 网感硬要求：全篇短句口语化、句子短到一屏字幕能放下即可（但成段输出，换行只在自然段之间，不许一句一行）；开头3秒必须有炸点钩子（用悬念/反差/震惊事实抓住注意力）；${HOOK_QUOTE_RULE}；不要说教不要书面语，像朋友聊天一样分享；严禁"今天给大家讲讲""哈喽大家好"这种平淡开头；
6. 【叙事组织】
${INFO_NARRATIVE_RULE}
7. 【事实纪律·零虚构】稿中所有具体事实（数字/价格/降幅/日期/人名/机构名/引语）必须能在上面资料里找到原句依据，资料没写的【一个字都不许补】：
   - 禁止虚构画面、动作与"网友戏码"：资料只概括事件、没有描写具体场面时，严禁自行脑补任何招式、走位、表情、对白、现场细节；严禁编造"有人排队/有人抢了多少台/网友发帖被拉黑/网友评论说"之类的现场描写、网友反应和小故事（资料里有原句的除外，引用时保持原意）；需要画面感只能复述资料明确写到的内容；
   - 禁止编造任何精确数字：价格、费用、降幅、速度、票数等，资料没给具体数值就【一个数字都不许写】（包括"X块钱/X元/X万"这类口语钱数）；资料只说"更便宜/降价"而没给钱数时，绝不能自己编一个具体钱数；
   - 禁止货币换算与配置传闻：资料给的是外币价格就不许自己换算成人民币口径；资料没提的价格档位、机型对比价一律不写；资料没提的产品配置、功能、参数传闻，无论你觉得可能性多大，都不许当事实写进稿子；
   - 时间口径以资料为准：资料说"计划/预计/将"就必须写成"即将/计划"，【严禁】提前宣布成"已经官宣/已发布/已降价"；资料标注的事件日期与今天不一致时，严禁用"今天/昨晚/昨天"指代该事件；
   - 禁止拿资料【外】的任何公司、产品、人物做高下对比；禁止补写资料没有的"以前怎样、现在怎样"的历史对比；
   - 禁止断言资料外的商业动机与行业定性：某家公司"垄断/收割利润/割韭菜/逼死同行/赔本赚吆喝"这类动机判断，资料没有原句就【不许当事实说】，只能放进结尾互动用提问口气抛给观众（如"这波到底是技术降本还是烧钱抢市场？你怎么看"）；
   - 数字必须照抄资料：百分比、价格、速度、日期一个数字都不许改（资料写 98% 就不能写成 99%）；
   - 结尾可以用一眼就能听出是玩笑的假设互动，但不得把玩笑里的虚构细节包装成事实陈述；
7. 直接输出脚本正文，不要任何解释、前言、标题或"以下是"之类的话。${capTail}${factTail}`;
    }

    const [rawScript, birthBlock] = await Promise.all([
      callLLM(prompt),
      birthProbeP,
    ]);
    if (!rawScript) {
      return NextResponse.json(
        { script: "", error: "脚本生成失败，请稍后重试。" },
        { status: 502 }
      );
    }
    // 字数兜底：只在超硬上限时触发一次压缩重写（合规时零额外调用/零延迟）。
    // 用户拍板：最多压两轮（软压+硬压复检），不循环。压缩目标取硬上限的95%留误差余量
    // （LLM压缩有±5%偏差，要求≤cap可能交761/726这种略超稿），压完即收。
    // 压缩指令要求"删信息点"而非"缩写句子"，保住口语网感；trimmed/chars 字段用于观测
    // prompt 直达率——若高频触发二次压缩，说明该档位 prompt 还要继续调，而不是依赖兜底。
    let finalScript = rawScript;
    let trimmed = false;
    if (capWords) {
      const rawChars = rawScript.replace(/\s/g, "").length;
      if (rawChars > capWords) {
        const squeezeRule = opinionMode
          ? `规则：\n- 优先保住中心论点的锋利表述与结尾金句/反问，按"反方段→最次要的一个分论点→类比举例"的顺序整段删，保留2个最强分论点也要论证完整；\n- 保持口语短句与原稿语感，禁止把口语缩写成书面语；\n- 不得稀释或中立化中心论点，不得引入原稿没有的事实与数字；\n- 只输出压缩后的正文，不要解释。`
          : `规则：\n- 删掉次要信息点与重复铺垫，保留开头炸点、信息量最高的事实与结尾互动；\n- 保持口语短句与原稿语感，禁止把口语缩写成书面语；\n- 不得引入原稿没有的事实，不得改动任何数字与专有名词；\n- 只输出压缩后的正文，不要解释。`;
        const squeezeOnce = async (
          src: string,
          srcChars: number,
          target: number,
          mode: "hard" | "micro" | "micro2"
        ) =>
          callLLM(
            `你在压缩一篇短视频口播稿。原稿约 ${srcChars} 字，要求压到 ${target} 字以内（含标点，这是硬性数字，超一个字都不行）。\n` +
              (mode === "micro"
                ? `只超了一点点：只允许删掉"其实/真的/就是/那个/然后/话说回来/我跟你讲"这类填充词、可有可无的语气小句和重复修饰，【不许】删任何信息点、论证层次和结构件（钩子/反方/反问），不许改变句子意思。\n`
                : mode === "micro2"
                  ? `当前稿 ${srcChars} 字，必须删到 ${target} 字以内，至少删掉 ${
                      srcChars - target
                    } 个字。逐句扫描，删除任何不改变事实与论证的字：副词（其实/真的/原来/就/还/也/都）、重复出现的主语、不影响意思的语气小句；信息点、论点词、反问一个都不能动。直接输出删改后的完整成稿。\n`
                  : `上一轮没压到位，本轮必须达标：逐句问"删掉它论证/信息链会不会断"，不会断就整句删；${
                      opinionMode
                        ? "保留中心论点句、2个最强分论点各一句、反方反驳一句、结尾反问，其余全删；"
                        : "保留开头钩子一句、核心事实、结尾一句，其余全删。信息块整块取舍，不许只修边角：同类并列（各地政策/各家公司/多名网友反应）最多保留2个例子；流程步骤只留用户最需要的第一步；历史背景只留与核心事实直接相关的一条；重复出现的同一日期/数字只保留第一次；"
                    }宁可短到${Math.round(target * 0.9)}-${target}字，也不许超。\n`) +
              `${squeezeRule}\n\n原稿：\n${src}`
          ).catch((e: unknown) => {
            // 观测：静默失败会让超上限稿原样返回（trimmed=false），此前线上出现过
            // 1056/990 未压缩但无任何日志可查；补一条 warn 便于区分"调用失败"与"模型压不动"。
            console.warn(
              `[script] squeeze(${mode}) call failed, keep previous:`,
              e instanceof Error ? e.message : String(e)
            );
            return "";
          });
        // 两轮复检（2026-09 实测：30秒档一轮压到 135 仍超 124 就被放行）。
        const target = Math.round(capWords * 0.95);
        const squeezed = await squeezeOnce(rawScript, rawChars, target, "hard");
        if (squeezed && squeezed.replace(/\s/g, "").length < rawChars) {
          let next = squeezed;
          let nextChars = next.replace(/\s/g, "").length;
          // 软压后仍超【产品红线】才二次调用；capWords~redLine 之间是 20% 容忍区，直接收。
          if (nextChars > redLine) {
            // 微超（≤8字）先上零成本确定性删词：实测 LLM 对"再删几个字"常常整段重写
            // 甚至压不动（133/138 反复出现）。删词能直接达标就不花这次调用。
            let detHandled = false;
            if (nextChars - redLine <= 8) {
              const det = microCutFillers(next, redLine, Math.round(redLine * 0.8));
              if (det) {
                next = det;
                nextChars = det.replace(/\s/g, "").length;
                detHandled = true;
              }
            }
            if (!detHandled) {
            // 仅微超红线（≤8字）走填充词微压，避免把好好的短稿整块砍崩；大超才硬删
            const mode = nextChars - redLine <= 8 ? "micro" : "hard";
            const secondTarget = mode === "micro" ? redLine : target;
            let second = await squeezeOnce(next, nextChars, secondTarget, mode);
            let secondChars = second.replace(/\s/g, "").length;
            // 二轮只在"更短且没压崩（≥目标一半，微压模式放宽到红线八成）"时采用
            const floor = mode === "micro" ? Math.round(redLine * 0.8) : Math.round(target * 0.5);
            const adoptable = (n: number) => n < nextChars && n >= floor;
            if (mode === "micro" && !(second && adoptable(secondChars) && secondChars <= redLine)) {
              // micro 没把住（模型对"只删词"指令常重写全文）：先试确定性删词，再不行
              // 换字数驱动指令最后试一次；两次微压总共只在"超线≤8字"路径触发
              const det = microCutFillers(next, redLine, floor);
              if (det) {
                second = det;
                secondChars = det.replace(/\s/g, "").length;
              } else {
                const retry = await squeezeOnce(next, nextChars, redLine, "micro2");
                const retryChars = retry.replace(/\s/g, "").length;
                if (retry && retryChars < nextChars && retryChars >= floor && retryChars <= redLine) {
                  second = retry;
                  secondChars = retryChars;
                }
              }
            }
            if (second && adoptable(secondChars)) {
              next = second;
            }
            }
          }
          finalScript = next;
          trimmed = true;
        }
      }
    }
    // 资讯稿 LLM 两轮压缩仍超产品红线时的确定性收尾（观点稿不动）：
    // 只删结尾无数字无问号的纯呼吁/重复总结段，有硬事实的尾段立即停手。
    if (
      !opinionMode &&
      action !== "polish" &&
      redLine > 0 &&
      finalScript.replace(/\s/g, "").length > redLine
    ) {
      const before = finalScript.replace(/\s/g, "").length;
      finalScript = trimOverlongInfoTail(finalScript, redLine);
      if (finalScript.replace(/\s/g, "").length < before) trimmed = true;
    }
    // 所有文体通用的最后保险：LLM 压缩全部走完仍微超红线（≤8字）时，纯代码删话语
    // 标记词。观点稿 30 秒档曾两轮 LLM 都压不动（138 字），填充词删除不动任何论点与
    // 事实，是比"超线稿直接返回"更安全的选择。
    if (
      action !== "polish" &&
      redLine > 0 &&
      finalScript.replace(/\s/g, "").length - redLine <= 8 &&
      finalScript.replace(/\s/g, "").length > redLine
    ) {
      const det = microCutFillers(finalScript, redLine, Math.round(redLine * 0.8));
      if (det) {
        finalScript = det;
        trimmed = true;
      }
    }
    // 年龄守卫（纯代码零token）：修复"当前年龄"旧记忆回潮（如人物已19岁稿里写18岁）。
    // 只动语法明确断言当前年龄的句子（今年/刚满/才X岁…）；过去事件年龄（"16岁出道"）
    // 与资料过去叙事中出现过的数字一律不碰；资料无出生日期则整体不生效。
    // ageSrc 额外并入并行探测的出生日期资料 birthBlock（2026-09）——报道/素材卡通常
    // 没有生日，不探这一路守卫永远空转，"18岁的人"与"19岁小孩"同稿打架就是这么漏的。
    // ageFixed 供观测。
    const ageRes = fixAgeClaims(
      [realReport, ...facts, ...memes, birthBlock].filter(Boolean).join("\n"),
      finalScript
    );
    finalScript = ageRes.text;
    // 确定性事实守卫（纯代码零token，2026-09 评测实证）：AI腔清除 + 价格脱敏 +
    // 百分比漂移修正（98%→99%）+ 无依据历史对比句剔除（"去年这时候…"）。
    // 联想证据块并入资料源：联想来的真实数字/年份也是"有依据"的，否则会被守卫误伤。
    const guardFactSource = groundBlock + assocBlock;
    const guardResMain = applyScriptGuards(finalScript, guardFactSource);
    finalScript = guardResMain.text;
    // 过短兜底（2026-09 评测实证）：generate 分支偶发只吐两句话（实测成稿仅 68 字，
    // 与"超长压缩"对称的失配）。对【短于目标字数60%】的成稿重发一次原 prompt+扩写提醒
    // （最多一轮），要求在不引入任何资料外事实的前提下把背景/反应/互动写完整；polish
    // 分支本身要求短，不触发。
    // 钩子伪引语守卫删过钩子时，减法可能把原本压线的稿子削到档下限以下（健身房案实测
    // 152<160），此时按【档位下限】而非常规 60% 线触发同一套扩写兜底。
    const shortFloor = guardResMain.hookDropped && lower ? lower : minWords;
    // 评测观测：过短扩写分支的决策痕迹（请求/产出字数、是否采用、守卫是否再次删钩子）
    let expandTrace: {
      shortN: number;
      expN: number;
      adopted: boolean;
      finalN?: number;
      hookDroppedAgain?: boolean;
    } | null = null;
    if (action !== "polish" && finalScript.replace(/\s/g, "").length < shortFloor) {
      const shortN = finalScript.replace(/\s/g, "").length;
      // 观点稿的"短"是论证没展开，扩写要补的是论证层次而不是事实细节；
      // 资讯稿维持原口径（补背景/反应，不许补资料外事实）。
      const expandHint = opinionMode
        ? `你上一版只有 ${shortN} 字，论证根本没展开，这不是合格的观点稿。请按上面的五段结构重写完整版：` +
          `立靶子之后，把递进论证做足（${
            effectiveReqSec >= 85 ? "3个" : "2个"
          }层层推进的分论点，每个都要有小论点+举例/推演/反问/对比/类比中的至少两种手法+点题句），` +
          `再补"反方最强版本与反驳"独立一段，最后金句+二选一反问。` +
          `用因果推演、群体心理分析、生活类比把篇幅写够；继续严禁按时间报资料流水账；` +
          `硬事实（数字/日期/人名/原话）仍不许编，拿不准的用限定说法。直接输出正文。`
        : `你上一版成稿只有 ${shortN} 字，严重短于上面的字数要求。请重新输出【完整】口播稿：` +
          `保留上一版已写的事实与钩子，严格依据上面资料把事件背景、关键信息、各方反应和结尾互动写完整，` +
          `字数必须达到上面第3条的要求。事实纪律不变：资料里没有的数字、价格、日期、动作细节、对比` +
          `一个字都不许补。直接输出正文。`;
      const hookRewriteHint = guardResMain.hookDropped
        ? `另外，上一版开头引用了资料里没有原句的话已被打回：这一版开头直接用事实或判断，` +
          `不要给资料里的间接陈述加引号、不要冒充当事人原话。`
        : "";
      const expanded = await callLLM(`${prompt}\n\n${expandHint}${hookRewriteHint}`).catch(
        () => ""
      );
      const expN = expanded ? expanded.replace(/\s/g, "").length : 0;
      if (expanded && expN > shortN + 50) {
        const g2 = applyScriptGuards(
          fixAgeClaims(
            [realReport, ...facts, ...memes, birthBlock].filter(Boolean).join("\n"),
            expanded
          ).text,
          guardFactSource
        );
        finalScript = g2.text;
        expandTrace = {
          shortN,
          expN,
          adopted: true,
          finalN: finalScript.replace(/\s/g, "").length,
          hookDroppedAgain: g2.hookDropped,
        };
      } else {
        expandTrace = { shortN, expN, adopted: false };
      }
    }
    // 超红线确定性兜底（见 reduceToRedline 注释）：压缩/守卫/扩写全部走完仍 > 红线时，
    // 用纯代码把稿子削回线内。放在这里是因为它必须压在【最后一道会往稿子里加字的分支】
    // （过短扩写）之后，否则扩写回来的超长稿又会漏出去。
    const beforeOver = finalScript.replace(/\s/g, "").length;
    let redlineTrim: { before: number; after: number; adopted: boolean } | null = null;
    if (action !== "polish" && redLine > 0 && beforeOver > redLine) {
      const reduced = reduceToRedline(finalScript, redLine, Math.round(redLine * 0.8), embed);
      if (reduced) {
        finalScript = reduced;
        trimmed = true;
      }
      redlineTrim = {
        before: beforeOver,
        after: reduced ? reduced.replace(/\s/g, "").length : beforeOver,
        adopted: !!reduced,
      };
    }
    // 植入内容出口自检（2026-09 评测实证）：prompt 已写"论点原义必须完整保留、严禁稀释偷换"，
    // 但模型仍偶发把用户点拨的内容换掉（门禁实测抓住过整句只剩 89% 的字、独独丢了"魔怔"，
    // 而评测端 mustContainThesis 是逐词 hard 检查，于是门禁硬失败）。纯文本手术拼不出自然句，
    // 故做【一次】定向补写。基准=植入框原文；触发=丢 ≥1 个片段（线见 THESIS_FIX_MIN_MISSING，
    // 采纳=缺失片段真的变少且字数仍在线内。全过程纯字符串比对，无模型参与。
    // 为什么只在观点稿（opinionMode）生效：植入框里用户写的可能是【主张】，也可能是【要讲哪几点
    // 的清单/创作要求】。主张本来就该原话保住（评测端也是逐词 hard 检查这一档）；清单是提纲，
    // 模型用自己的话把那几点讲清楚即可，不可能把"具体幅度""普通人需"这种条目原样写进稿子，
    // 实测这类植入框 3/3 触发而 0 采纳（白跑一次改写，成稿不变）；30 秒短档同理塞不下原话。
    // 判"主张还是清单"不另建规则，直接用分类器已经给出的意图结论 intent.mode。
    const userClaim = embed;
    let thesisFix: { missingBefore: string[]; missingAfter: string[]; adopted: boolean } | null =
      null;
    // action=polish 产出的是梗概提纲，不是成稿，不适用本自检
    if (action !== "polish" && opinionMode && userClaim) {
      const chunks = embedChunks(userClaim);
      const missingBefore = chunks.filter((c) => !chunkKept(c, coreOf(finalScript)));
      if (missingBefore.length >= THESIS_FIX_MIN_MISSING) {
        const fixHint =
          `你上一版把用户点名要植入的内容里这些表述换成了别的说法：${missingBefore.join("、")}。` +
          `用户给的是「${userClaim}」——这是作者指定要植入的台词/表述，必须原样出现在稿里，` +
          `不许换成同义说法、不许绕开。请只把这几处按用户给的原话改回来（必要时用一句话把原意说透），` +
          `其余句子、段落结构、总字数一律不要动。直接输出全文。`;
        const fixedRaw = await callLLM(`${prompt}\n\n${fixHint}`).catch(() => "");
        if (fixedRaw) {
          const g3 = applyScriptGuards(
            fixAgeClaims(
              [realReport, ...facts, ...memes, birthBlock].filter(Boolean).join("\n"),
              fixedRaw
            ).text,
            guardFactSource
          );
          const missingAfter = chunks.filter((c) => !chunkKept(c, coreOf(g3.text)));
          const len3 = g3.text.replace(/\s/g, "").length;
          const lenOk = len3 >= shortFloor && (!redLine || len3 <= redLine);
          const adopted = missingAfter.length < missingBefore.length && lenOk;
          if (adopted) finalScript = g3.text;
          thesisFix = {
            missingBefore,
            missingAfter: adopted ? missingAfter : missingBefore,
            adopted,
          };
        } else {
          thesisFix = { missingBefore, missingAfter: missingBefore, adopted: false };
        }
      }
    }
    return NextResponse.json({
      script: finalScript,
      chars: finalScript.replace(/\s/g, "").length,
      trimmed,
      ageFixed: ageRes.fixed,
      // 素材量不足自动降档时给用户的说明（空串=档位不变，前端不展示）
      ...(downgrade ? { downgrade } : {}),
      // 联想增强实际用到的取证来源（开启且有轴通过闸门时）：前端在稿下折叠展示，
      // 让用户看得见"联想"凭的是什么，而不是模型自己上价值。
      ...(association?.sources.length
        ? { associationSources: association.sources }
        : {}),
      // 评测探针（仅 _evalGround 时返回）：回传脚本生成时实际依据的事实块与抓取统计
      ...(body?._evalGround
        ? {
            groundBlock: (groundBlock + assocBlock).slice(0, 12000),
            intent: {
              mode: intent.mode,
              thesis: intent.thesis,
              embedBits: intent.embedBits,
              ragHits: action === "generate" ? ragHitsCount : 0,
            },
            association: association
              ? {
                  wanted: associateWanted,
                  twoStep: associationPlan !== null,
                  selected: associationSelection
                    ? { axisIds: associationSelection.axisIds, stanceByAxis: associationSelection.stanceByAxis || {} }
                    : null,
                  axes: association.axes.map((a) => ({
                    id: a.id,
                    kind: a.kind,
                    axis: a.axis,
                    gate: a.gate || null,
                    evidenceCount: a.evidenceCount || 0,
                    stances: (a.stances || []).map((s) => ({
                      id: s.id,
                      stance: s.stance,
                      gate: s.gate || null,
                      evidenceCount: s.evidenceCount || 0,
                    })),
                  })),
                  sources: association.sources.length,
                }
              : null,
            fetchStats: {
              candidates: candidateMap.size,
              fetched: docs.length,
              full: fullDocs.length,
              fullCn,
              snippetCn: snipCn,
              reportCn,
              factsCn,
              supportSec,
              reqSec,
              downgrade: downgrade || null,
              hookStyle,
              endStyle,
              opinionArc: opinionArcName,
              picked: docs.map((d) => ({
                title: d.title.slice(0, 40),
                source: d.source,
                full: d.full,
                cn: d.cn,
              })),
            },
            expandTrace,
            thesisFix,
            redlineTrim,
          }
        : {}),
    });
  } catch (e: any) {
    // Key 缺失/无效/欠费/限流：返回结构化引导，前端渲染「配置 Key / 去充值」按钮
    const action = llmErrorAction(e);
    if (action) {
      return NextResponse.json(
        { script: "", error: action.message, llmError: action },
        { status: action.httpStatus }
      );
    }
    return NextResponse.json(
      { script: "", error: `脚本生成失败：${e?.message || e}` },
      { status: 500 }
    );
  }
}
