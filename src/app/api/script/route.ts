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
  type ScriptIntent,
} from "../_shared/scriptIntent";
import { retrieveKnowledge, formatKnowledge } from "../../../lib/rag";
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
import { fixNumberDrift } from "../../../lib/numberGuard";
import { getLlm, isInternalRequest, llmChatJson, llmErrorAction, resolveRequestLlm, setRequestLlm } from "../../../lib/llm";

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
// 出口纯文本手术：第一句（首个句末标点前）超 24 字且内部 8-24 字位置有逗号时，
// 把第一个逗号改成句号——口播上本就该在此停顿，不改词不删信息。只动首句一处。
function breakLongFirstSentence(text: string): string {
  if (!text) return text;
  const firstPara = text.split(/\n/)[0];
  const m = firstPara.match(/^[^。．！？!?]{25,}[。．！？!?]/);
  if (!m) return text;
  const head = m[0];
  const comma = head.match(/^(.{8,24}?)[，,]/);
  if (!comma) return text;
  const after = head.slice(comma[0].length);
  if (after.replace(/[。．！？!?\s]/g, "").length < 6) return text;
  const idx = comma[0].length - 1;
  // head 从文本 0 位置开始，逗号偏移即全文偏移（首段即开头）
  return text.slice(0, idx) + "。" + text.slice(idx + 1);
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
function applyScriptGuards(script: string, factSource: string): string {
  let out = fixNumberDrift(script, factSource);
  out = redactUngroundedPrices(out, factSource);
  out = dropUngroundedHistory(out, factSource);
  out = dropUngroundedDurations(out, factSource);
  out = dropDegenerateClauses(out);
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
  return out
    .replace(/\n{3,}/g, "\n\n")
    // 句末标点叠床架屋（2026-09 实测观点稿结尾"你怎么选？。"）：问号/叹号已结束句子，
    // 后面的句号删掉；重复句点归一。纯出口标点清洗，不动文字。
    .replace(/([？?!！])[。.．]+/g, "$1")
    .replace(/。{2,}/g, "。")
    .trim();
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
    const pickStyle = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
    const hookStyle = pickStyle(HOOK_STYLES);
    const endStyle = pickStyle(END_STYLES);
    const effectiveReqSec = midWords ? Math.round(midWords / 4.5) : reqSec;
    const structureGuide =
      type === "口播稿"
        ? `\n\n【本篇结构安排】（系统按条轮换以避免千篇一律，本条必须照用，不要自行换成别的开头/结尾套路）\n- 开头钩子：${hookStyle}\n- 收束方式：${endStyle}${
            effectiveReqSec >= 85
              ? "\n- 本篇较长：约一半处用一个资料里真实有的转折/加码/新角度形成二次钩子，避免平铺"
              : ""
          }\n结构只决定"怎么讲"，所有事实仍然只能出自上面的资料；指定钩子若在资料里找不到对应素材，就退回用数字事实钩，不许为套结构编素材。`
        : "";

    // 事实依据组装：报道（若有）在前，原文摘录/快照随后；报道缺失但有抓取资料也成立。
    let groundBlock = "";
    if (realReport && docsBlock) {
      groundBlock = `该热点事件网上相关的高热度报道与原文资料如下，请以此为事实依据，不要编造资料之外的事实。${freshAnchor}\n${realReport}\n\n${docsBlock}`;
    } else if (realReport) {
      groundBlock = `该热点事件网上相关的高热度报道如下，请以此为事实依据，不要编造报道之外的事实。${freshAnchor}\n${realReport}`;
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
      const [samples, ragHits] = await Promise.all([
        pickRelevantTemplates(topic, domain, 5, callLLM),
        ragQuery.length >= 4
          ? retrieveKnowledge(ragQuery, { topK: 3, minScore: 0.35 }).catch(() => [])
          : Promise.resolve([]),
      ]);
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
      const factTail = opinionMode
        ? ""
        : `\n【事实终检·交稿前必做】把稿中每一个数字、百分比、年份、时长（X年/X个月/X天）、人名机构名、平台榜单名、引语，回到上面资料里逐条找原句；找不到原句的那一句立刻整句删掉，不许换个模糊说法留下。` +
          `\n时态不许反：资料里"将于/刚开始/进行中"的事件，绝不能写成"已结束/刚结束/落幕"；今天是${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}（北京时间），按资料日期推断事件处于哪个阶段就写哪个阶段，资料没说结束就不许写结束。` +
          `\n引语不许造假：引号内或冒号后的直接引语必须是资料原句；只拿到大意时一律写成转述（"他表示/公开表态大意是"），禁止给转述配上引号、禁止替人物造句。` +
          (midWords
            ? `\n【信息块预算·硬约束】全稿约${midWords}字最多讲${midWords < 300 ? 3 : 4}个信息块：同类并列（各地政策/各家公司产品/多名网友反应）最多写2个例子；操作流程只留用户最需要的第一步，其余一句话带过或不写；超出预算的信息块【整块不写】，不许靠缩短句子硬塞。`
            : "");
      prompt = opinionMode
        ? `你是靠"观点锐评"涨粉的头部短视频口播博主。观众刷到你，不是来听新闻复述，是来听你把一个有争议的判断掰开揉碎讲透。请基于【用户给出的中心论点】，写一篇可以直接对着镜头讲的观点评论口播稿。

【本条视频的中心论点·用户原话】
「${centerThesis}」
这是全稿唯一主线：你的任务是把这个判断论证清楚、讲出别人没想到的层次，不是把它复述成中立总结。论点原义必须在稿中完整保留，【严禁】稀释、偷换，【严禁】和稀泥写成"一方面…另一方面…各有各的道理"，也【严禁】因为话说得尖锐就擅自改温和、改中立。

【由头事件】「${topic}」${from}
【论据库】（注意：下面的资料是你论证的弹药，不是要你播报的内容）
${groundBlock}${entityRule}${materialBlock}${outlineBlock}${voiceBlock}${ragBlock}
${embedMaterial ? `\n可以自然用上的用户指定梗/台词（用不上别硬塞）：\n${embedMaterial}` : ""}

按以下结构写（${
          effectiveReqSec >= 85
            ? "本篇较长，五个部分一个都不能省"
            : "短稿可把第4部分并入第3部分"
        }；整篇直接成段口播，2-4个自然段，不要写小标题、序号或分镜提示）：
1. 开头3秒：直接甩判断或反常识断言，第一句（到第一个句号/问号/感叹号为止）不超过20字，第一句就让人停下来。严禁自我介绍、"今天聊聊"、"先问大家一个问题"。
2. 立靶子：先讲清流行看法或对立面怎么说，再亮出上面的中心论点——冲突本身就是留人点。
3. 递进论证（占全稿一半以上篇幅）：${
          effectiveReqSec >= 85 ? "3" : "2"
        }个分论点层层推进（现象→原因→本质或推演，段落顺序不能互换）；每个分论点按"一句小论点开头 → 论证 → 一句点题"展开；举例、因果推演、反问、对比、生活类比这五种手法至少用到三种；每个抽象判断后面立刻跟一个具体落点（谁、在什么场景下、发生了什么）。
4. 反方最强版本与反驳：替反对者把他最有道理的那句话讲出来，先承认其中对的部分，再划清你不同意的地方——这比自说自话可信十倍。
5. 收尾：一句能截图传播的金句回扣中心论点，再抛一个贴着这件事的具体二选一反问丢给评论区，不喊空泛口号。

【素材使用纪律】
- 资料是证据不是菜单：一篇帖子、一个回答、一条评论，只取与当前分论点有关的一个细节、数字或心态，用"有人算过一笔账""一个高赞回答的逻辑是""网上有种说法"模糊化转述；【严禁】"X月X日某平台有个帖子说……后来又有个回答说……"这种按时间报幕、逐条总结资料的写法。
- 每用一次素材，后面必须接你自己的分析（这恰好说明了什么／问题到底出在哪），引完必评，不许素材裸奔。
- 观点论证【允许而且必须写足】：因果推演、群体心理分析、生活类比、反方假设、逻辑反驳——这些是观点稿的主体，不属于编造事实，不要因为"资料里没写"就不敢讲；但资料里没有的【硬事实】（具体数字、日期、人名机构名、原话引用）一个字都不许编，拿不准的用"目前能看到的说法是"限定。
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
5. 网感硬要求：全篇短句口语化、句子短到一屏字幕能放下即可（但成段输出，换行只在自然段之间，不许一句一行）；开头3秒必须有炸点钩子（用悬念/反差/震惊事实抓住注意力）；不要说教不要书面语，像朋友聊天一样分享；严禁"今天给大家讲讲""哈喽大家好"这种平淡开头；
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
            // 仅微超红线（≤8字）走填充词微压，避免把好好的短稿整块砍崩；大超才硬删
            const mode = nextChars - redLine <= 8 ? "micro" : "hard";
            const secondTarget = mode === "micro" ? redLine : target;
            let second = await squeezeOnce(next, nextChars, secondTarget, mode);
            let secondChars = second.replace(/\s/g, "").length;
            // 二轮只在"更短且没压崩（≥目标一半，微压模式放宽到红线八成）"时采用
            const floor = mode === "micro" ? Math.round(redLine * 0.8) : Math.round(target * 0.5);
            const adoptable = (n: number) => n < nextChars && n >= floor;
            if (mode === "micro" && !(second && adoptable(secondChars) && secondChars <= redLine)) {
              // micro 没把住（模型对"只删词"指令常重写全文）：换字数驱动指令再试一次，
              // 仍是微调不动结构；两次微压总共只在"超线≤8字"路径触发，常规长稿不受影响
              const retry = await squeezeOnce(next, nextChars, redLine, "micro2");
              const retryChars = retry.replace(/\s/g, "").length;
              if (retry && retryChars < nextChars && retryChars >= floor && retryChars <= redLine) {
                second = retry;
                secondChars = retryChars;
              }
            }
            if (second && adoptable(secondChars)) {
              next = second;
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
    finalScript = applyScriptGuards(finalScript, groundBlock);
    // 过短兜底（2026-09 评测实证）：generate 分支偶发只吐两句话（实测成稿仅 68 字，
    // 与"超长压缩"对称的失配）。对【短于目标字数60%】的成稿重发一次原 prompt+扩写提醒
    // （最多一轮），要求在不引入任何资料外事实的前提下把背景/反应/互动写完整；polish
    // 分支本身要求短，不触发。
    if (action !== "polish" && finalScript.replace(/\s/g, "").length < minWords) {
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
      const expanded = await callLLM(`${prompt}\n\n${expandHint}`).catch(() => "");
      if (expanded && expanded.replace(/\s/g, "").length > shortN + 50) {
        finalScript = applyScriptGuards(
          fixAgeClaims(
            [realReport, ...facts, ...memes, birthBlock].filter(Boolean).join("\n"),
            expanded
          ).text,
          groundBlock
        );
      }
    }
    return NextResponse.json({
      script: finalScript,
      chars: finalScript.replace(/\s/g, "").length,
      trimmed,
      ageFixed: ageRes.fixed,
      // 素材量不足自动降档时给用户的说明（空串=档位不变，前端不展示）
      ...(downgrade ? { downgrade } : {}),
      // 评测探针（仅 _evalGround 时返回）：回传脚本生成时实际依据的事实块与抓取统计
      ...(body?._evalGround
        ? {
            groundBlock: groundBlock.slice(0, 9000),
            intent: {
              mode: intent.mode,
              thesis: intent.thesis,
              embedBits: intent.embedBits,
              ragHits: action === "generate" ? ragHitsCount : 0,
            },
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
              picked: docs.map((d) => ({
                title: d.title.slice(0, 40),
                source: d.source,
                full: d.full,
                cn: d.cn,
              })),
            },
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
