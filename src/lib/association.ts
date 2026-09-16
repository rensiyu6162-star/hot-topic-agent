// 观点稿「联想增强」管线（2026-09，用户需求：就事论事之外，能就事件联想到更大的
// 结构性议题——但不能跑偏、不能说空话）。
//
// 二代设计（2026-09-16 用户痛批"只有统计数字、触不到同类事件并案与成因深析"后重写）：
//  联想方向分三类，全部由模型针对本题现场生成（内容中立，代码里不内置任何领域/案例词）：
//   ① data       数据背景：统计 / 政策 / 史料硬数据
//   ② precedent  同类先例：别的时间地点、有权威报道的同类事件（只许并列事实+强制写异同）
//   ③ explanation 成因剖析：几派相互竞争的成因假说，由创作者勾一个主打，其余作反方
//
// 核心原则（业界 Step-back Prompting + Multi-query + Answerability gating 的本项目落地）：
//  ①发散阶段 LLM 只许产出「可被公开资料回答的事实型检索问题」，严禁产出任何结论；
//  ②每个方向真实联网取证，只走自建免费源（noCommercial），联想是增值探索，
//      没搜到证据宁可不联想，绝不为发散烧商业 API 额度；
//  ③证据闸门由机器规则按方向类型分别判定，LLM 不当裁判（会放水）；
//  ④没通过闸门的方向对写稿模型不可见——模型事后不知道它存在过，杜绝脑补；
//  ⑤两步交互：propose 先发散+预取证给创作者勾选，generate 只按勾选项取证写稿，
//      跑偏在写稿前就被人拦住。
import { searxSearchUnion, AUTHORITY_HOST_RE, type SearxHit } from "./searx";

export type AssociationKind = "data" | "precedent" | "explanation";

// 成因假说方向（explanation 轴专用）：每个 stance 是一派相互竞争的解释
export type AssociationStance = {
  id: string;
  stance: string; // 中性假说名（如某学术传统/解释层次）
  reason: string; // 这一假说如何解释眼前这类事（一句话，不许宣判它是真因）
  queries: string[]; // 查该学派理论/研究者/实证研究的检索问题
  // —— 以下为预取证阶段填充（proposal 响应携带，供前端置灰与验真）——
  gate?: "pass" | "fail";
  evidenceCount?: number;
  sampleTitles?: string[];
  // 预取证拿到的全部证据（标题+链接），供方向卡展开验真；generate 不信任客户端回传值
  evidenceSamples?: { title: string; url: string }[];
  // 服务端内部：预取证已验真的完整事实（仅存服务端缓存，不随响应下发）
  verifiedFacts?: AssociationFact[];
};

export type AssociationAxis = {
  id: string;
  kind: AssociationKind;
  axis: string; // 中性现象名称
  reason: string; // 与眼前事件的关系
  // data / precedent 用
  queries?: string[];
  // explanation 用：2-3 个互斥成因方向
  stances?: AssociationStance[];
  // —— 预取证填充 ——//
  gate?: "pass" | "fail";
  evidenceCount?: number;
  sampleTitles?: string[];
  evidenceSamples?: { title: string; url: string }[];
  // 服务端内部：预取证已验真的完整事实（仅存服务端缓存，不随响应下发）
  verifiedFacts?: AssociationFact[];
};

export type AssociationFact = {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  authority: boolean;
};

// 创作者在方向卡上的选择：选中的轴 id；explanation 轴还要指明主打 stance
export type AssociationSelection = {
  axisIds: string[];
  stanceByAxis?: Record<string, string>;
};

export type AssociationResult = {
  axes: AssociationAxis[]; // 发散出的全部候选轴（观测用）
  evidence: AssociationAxis[]; // 通过证据闸门的轴（带 facts 时用于渲染）
  block: string; // 注入写稿 prompt 的证据块（空串=按普通稿写）
  sources: { title: string; url: string }[]; // 前端展示联想依据
};

// ── 预取证结果的服务端缓存 ─────────────────────────────────────────────
// propose 阶段已联网+LLM 验真过的完整事实只存服务端内存，generate 凭一次性 token 取回：
// 用户在方向卡上看到、勾选的那批证据就是写稿所用证据（所见即所得），既不信任客户端回传、
// 也不让 generate 的二次检索波动把用户已确认的方向静默抹掉，还省掉一轮检索+验真延迟。
// 容器重启/超时导致缓存不在时，render 自动回退到重新取证（fail-open）。
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const PROPOSAL_CACHE_MAX = 64;
// 缓存同时绑定 topic：token 只对同一话题有效，防止拿 A 题的方向卡 token 配 B 题的
// 勾选请求，把 A 题验过的事实塞进 B 稿。
const proposalStore = new Map<string, { at: number; axes: AssociationAxis[]; topic: string }>();

export function rememberProposal(axes: AssociationAxis[], topic: string): string {
  let token = "";
  for (let i = 0; i < 4; i++) {
    token = (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(0, 22);
    if (!proposalStore.has(token)) break;
  }
  proposalStore.set(token, { at: Date.now(), axes, topic });
  if (proposalStore.size > PROPOSAL_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of proposalStore) {
      if (now - v.at > PROPOSAL_TTL_MS) proposalStore.delete(k);
    }
    if (proposalStore.size > PROPOSAL_CACHE_MAX) {
      const oldest = [...proposalStore.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) proposalStore.delete(oldest[0]);
    }
  }
  return token;
}

export function recallProposal(token: unknown, topic: string): AssociationAxis[] | null {
  if (typeof token !== "string" || !/^[a-z0-9]{8,24}$/.test(token)) return null;
  const hit = proposalStore.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > PROPOSAL_TTL_MS) {
    proposalStore.delete(token);
    return null;
  }
  if (hit.topic !== topic) return null;
  return hit.axes;
}

// 剥掉只许留在服务端的 verifiedFacts，再把方向卡下发给前端
export function toPublicAxes(axes: AssociationAxis[]): AssociationAxis[] {
  return axes.map((a) => ({
    ...a,
    verifiedFacts: undefined,
    stances: a.stances?.map((s) => ({ ...s, verifiedFacts: undefined })),
  }));
}

const MAX_AXES = 3; // 每类最多 1 个轴，总数上限 3
const MAX_STANCES = 3;
// 候选名额要显著大于过闸需要的条数：实测搜索结果前几位常被同名词条/官网首页占据，
// cap 太小会让排在后面的对题论文/报道见不到验真官。最终过闸仍需验真+数量双保险。
const PER_FACTS_DATA = 6;
const PER_FACTS_PRECEDENT = 6;
const PER_FACTS_STANCE = 6;
const SEARCH_TIMEOUT_MS = 8000;

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

// 导航壳页面判定（内容中立的结构规则）：网站首页、index 页、繁简转码 /gate/ 镜像壳，
// 以及媒体频道每日摘要页（一页几十条外链、本身不承载具体事实）——权威域名下的这类页面
// 【不算】权威证据，否则一条 gov.cn 首页或频道摘要就能给任何方向"背书"
// （实测两次踩坑：gov.cn 首页+镜像页、people /GB/review/ 摘要页凑数过闸门）。
function isNavPage(u: string): boolean {
  let host = "";
  let path = "";
  try {
    const url = new URL(u);
    host = url.hostname;
    path = url.pathname;
  } catch {
    return true;
  }
  if (path === "" || path === "/") return true;
  if (/\/gate\//i.test(path)) return true;
  if (/\/index(?:\.(?:html?|shtml|jsp|php|aspx))?\/?$/i.test(path)) return true;
  // 人民网观点频道每日摘要页（如 /GB/review/20160929.html）：目录壳，不是具体文章
  if (/people\.com\.cn$/i.test(host) && /^\/GB\/review\/\d+\.html/.test(path)) return true;
  return false;
}

// UGC/自媒体平台判定（内容中立的平台类型规则）：任何注册用户都能发文、无事实核验环节的
// 平台内容页（头条号、网易号、百家号、知乎问答、CSDN 博客、豆瓣、B2B 问答等），
// 不能作为统计数据/学术假说/先例案例的证据计入闸门——它们可以被检索到，但进不了证据池。
function isLowGradeUrl(u: string): boolean {
  let host = "";
  let path = "";
  try {
    const url = new URL(u);
    host = url.hostname;
    path = url.pathname;
  } catch {
    return true;
  }
  if (/b2b\.baidu\.com$/i.test(host)) return true; // 百度爱采购问答
  if (/zhidao\.baidu\.com$/i.test(host)) return true; // 知道问答
  if (/baijiahao\.baidu\.com$/i.test(host)) return true;
  if (/(^|\.)toutiao\.com$/i.test(host) && /^\/(group|w|a\d|article)/.test(path)) return true; // 头条号/头条wiki聚合
  if (/(^|\.)163\.com$/i.test(host) && /\/(article|dy\/article)\//.test(path)) return true; // 网易号
  if (/(^|\.)(csdn\.net|zhihu\.com|douban\.com|xiaohongshu\.com)$/i.test(host)) return true;
  return false;
}

// URL 归一化去重：去 www/big5/m 镜像主机前缀、/gate 转码路径、query/hash、末尾斜杠。
function normUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^(?:www|big5|m|wap)\./, "");
    const path = url.pathname
      .replace(/^\/gate\/(?:big5|gb|simplified|traditional)\/[^/]*/i, "")
      .replace(/\/+$/, "");
    return `${host}${path || "/"}`;
  } catch {
    return u;
  }
}

// 粗粒度"不同来源站点"计数：同一媒体对同一事件的多篇报道不能当多个独立证据。
// 去掉常见主机前缀后按主机串去重（gov.cn 子站互并不影响先例类：先例多在媒体域名）。
function distinctHosts(facts: AssociationFact[]): number {
  return new Set(
    facts.map((f) => hostOf(f.url).replace(/^(?:www|big5|m|wap)\./, "").replace(/\.$/, ""))
  ).size;
}

// 发散：让模型从事件抽象三类联想方向。纯结构机制，prompt 内不含任何领域词/案例词；
// 返回结论性内容的方向由校验丢弃。
export async function proposeAssociationAxes(
  topic: string,
  thesis: string,
  llm: (prompt: string) => Promise<string>
): Promise<AssociationAxis[]> {
  const prompt = `你在为一条短视频观点评论稿做"选题发散"，只做发散，不写稿、不下结论。

【眼前的由头事件】
「${topic}」
${thesis ? `【创作者的中心论点】\n「${thesis}」` : "【创作者的中心论点】\n（未提供，只从事件本身发散）"}

任务：从这件事出发，给出最多 ${MAX_AXES} 个"联想方向"，每类最多 1 个，类型从下列三种里挑，不适合的类型不要硬给：

1. data 数据背景：这件事可能只是其一个缩影的、被公开统计/政策/史料记录过的长期现象。
2. precedent 同类先例：与眼前事件机制相似、但发生在别的时间/地点/人物身上、且有权威公开报道或正式处理结果的历史事件。
3. explanation 成因解释：解释"这类事为什么会反复发生"的、几派相互竞争的假说方向，供创作者选一个深挖。

字段要求：
- axis：中性的现象/关系名称，严禁结论、褒贬、金句；
- reason：一句话说清它与眼前事件的关系；牵强附会、硬蹭宏大概念的方向不许给；
- data / precedent 两类给 queries：1-2 个事实型检索问题，答案必须是公开网页上直接找得到的东西（统计数据、比例、年份、政策条文、可考历史事件的权威报道），每个 4-40 字；
  · 不许带眼前事件当事人名（要查的是结构现象或别的案例，不是这件事本身）；
  · precedent 的问题要描述"事件类型特征 + 时间跨度/地域"等可检索特征，让搜索引擎能捞到【别的】具名案例；
- explanation 类不给 queries，改给 stances（2-${MAX_STANCES} 个相互竞争的成因方向），每个 stance 含：
  · stance：中性的假说名；几个方向必须落在【不同解释层次】上（例如可指向先天/生物机制、个体成长经历、社会文化结构等不同层级——这只是"不同层次"的示例，不是限定选项，必须按本题真实生成）；
  · reason：一句话说明这一假说如何解释眼前这类事，不许宣判它就是真因；
  · queries：1-2 个能查到该假说对应的【学术理论/学派/研究者/实证研究/权威深度论述】的具体检索问题（要含学派或理论关键词），4-40 字，不带当事人名；
  · 严禁换汤不换药的同义重复方向；严禁指向"天生邪恶/骨子里坏"这类查不到任何系统研究的方向；严禁自己宣判哪个方向正确。

宁缺毋滥：某类不合适就不给；三类都没有可公开取证的方向，就返回空数组。
只返回一个 JSON 对象，不要解释、不要 markdown 代码块：
{"axes":[{"kind":"data","axis":"中性现象名","reason":"与眼前事件的关系","queries":["具体检索问题"]},{"kind":"precedent","axis":"","reason":"","queries":[""]},{"kind":"explanation","axis":"","reason":"","stances":[{"stance":"中性假说名","reason":"","queries":[""]}]}]}`;
  let raw: string;
  try {
    raw = await llm(prompt);
  } catch (e) {
    console.warn(
      "[association] 发散方向 LLM 调用失败，放弃联想增强:",
      (e as Error)?.message || e
    );
    return [];
  }
  const txt = String(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch (e) {
    console.warn("[association] 发散方向 JSON 解析失败:", (e as Error)?.message || e);
    return [];
  }
  const rawAxes = (parsed as { axes?: unknown })?.axes;
  if (!Array.isArray(rawAxes)) return [];
  const clean = (v: unknown): string =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const cleanQueries = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map(clean).filter((q) => q.length >= 4 && q.length <= 40).slice(0, 2)
      : [];

  const out: AssociationAxis[] = [];
  const usedKinds = new Set<AssociationKind>();
  for (const item of rawAxes) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = clean(o.kind) as AssociationKind;
    if (kind !== "data" && kind !== "precedent" && kind !== "explanation") continue;
    if (usedKinds.has(kind)) continue; // 每类最多 1 个
    const axis = clean(o.axis).slice(0, 30);
    const reason = clean(o.reason).slice(0, 80);
    if (axis.length < 2 || reason.length < 4) continue;

    if (kind === "explanation") {
      const rawStances = Array.isArray(o.stances) ? o.stances : [];
      const stances: AssociationStance[] = [];
      for (const s of rawStances) {
        if (!s || typeof s !== "object") continue;
        const so = s as Record<string, unknown>;
        const stance = clean(so.stance).slice(0, 20);
        const sReason = clean(so.reason).slice(0, 80);
        const queries = cleanQueries(so.queries);
        if (stance.length >= 2 && sReason.length >= 4 && queries.length >= 1) {
          stances.push({ id: "", stance, reason: sReason, queries });
        }
        if (stances.length >= MAX_STANCES) break;
      }
      // 成因轴必须至少有 2 派不同方向，否则不构成"可选择的竞争解释"
      if (stances.length < 2) continue;
      const id = `a${out.length}`;
      stances.forEach((st, j) => (st.id = `${id}-s${j}`));
      out.push({ id, kind, axis, reason, stances });
    } else {
      const queries = cleanQueries(o.queries);
      if (queries.length < 1) continue;
      out.push({ id: `a${out.length}`, kind, axis, reason, queries });
    }
    usedKinds.add(kind);
    if (out.length >= MAX_AXES) break;
  }
  return out;
}

function isAuthorityFact(u: string): boolean {
  return AUTHORITY_HOST_RE.test(hostOf(u)) && !isNavPage(u);
}

function toFact(h: SearxHit): AssociationFact {
  const url = String(h.url || "");
  return {
    title: String(h.title || "").trim().slice(0, 80),
    url,
    snippet: String(h.content || "").trim().slice(0, 220),
    ...(h.published ? { published: String(h.published) } : {}),
    authority: isAuthorityFact(url),
  };
}

// 单个取证单元（一个数据轴 / 先例轴 / 成因方向）：
// 首查结果不足时有第二查询补一枪；归一化去重；按单元类型截断条数。
// 机器层只做"页面形态"过滤（去首页/镜像壳、去重、去商业站——商业站由 searx noCommercial 兜），
// 不再用"标题带数字"当相关性判据：相关性统一交给后面的 LLM 验真，避免好报道在见验真官前被误杀。
async function gatherUnit(
  queries: string[],
  kind: AssociationKind
): Promise<{ facts: AssociationFact[]; raw: number }> {
  const facts: AssociationFact[] = [];
  const seen = new Set<string>();
  let raw = 0;
  const cap = kind === "precedent" ? PER_FACTS_PRECEDENT : kind === "data" ? PER_FACTS_DATA : PER_FACTS_STANCE;
  // 跨查询轮换取前 cap 条：让两个检索问题都有机会进入候选，避免首查的前几条占满名额；
  // raw 统计全部去重命中（含超 cap 与导航页），供取证漏斗日志定位是"搜不到"还是"被刷掉"。
  const absorb = (batches: SearxHit[][]) => {
    const maxLen = batches.reduce((m, b) => Math.max(m, b.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const hits of batches) {
        const h = hits[i];
        if (!h) continue;
        const url = String(h.url || "");
        if (!url) continue;
        const key = normUrl(url);
        if (seen.has(key)) continue;
        seen.add(key);
        raw += 1;
        // 形态不合格：首页/频道摘要壳、UGC 自媒体页（无核验环节，不能充当数据/学术/先例证据）
        if (facts.length >= cap || isNavPage(url) || isLowGradeUrl(url)) continue;
        facts.push(toFact(h));
      }
    }
  };
  try {
    // 两个查询始终并行（形态放宽后首查极易占满 cap，不能再等首查"弱"才补枪）；
    // 两轮结果轮换取样、跨查询去重，相关性统一交给后面的 LLM 验真。
    const batches = await Promise.all(
      [queries[0], queries[1]].filter(Boolean).map((q) =>
        searxSearchUnion(q, {
          limit: 8,
          safesearch: 0,
          timeoutMs: SEARCH_TIMEOUT_MS,
          noCommercial: true,
        }).catch((e) => {
          console.warn(
            `[association] 取证检索失败 q=${String(q || "").slice(0, 24)}:`,
            (e as Error)?.message || e
          );
          return [] as SearxHit[];
        })
      )
    );
    absorb(batches);
  } catch (e) {
    console.warn(
      `[association] 取证单元异常 q=${String(queries[0] || "").slice(0, 24)}:`,
      (e as Error)?.message || e
    );
  }
  return { facts, raw };
}

// 单元闸门（facts 均已通过 LLM 相关性验真）：
// data/成因方向 = 1 条权威深层页 或 2 条验真通过的相关来源；
// precedent = 至少 2 条且来自不同站点（同事件多媒体报道的合并义务交给写稿纪律）。
function unitGate(kind: AssociationKind, facts: AssociationFact[]): boolean {
  if (!facts.length) return false;
  if (kind === "precedent") return facts.length >= 2 && distinctHosts(facts) >= 2;
  return facts.some((f) => f.authority) || facts.length >= 2;
}

// 待验真的取证单元：方向（或某派成因）+ 它的检索问题 + 机器初筛后的候选证据
type RelevanceUnit = {
  id: string;
  label: string;
  reason: string;
  queries: string[];
  facts: AssociationFact[];
};

// LLM 批量"相关性验真"：机器闸门只判证据硬不硬（权威/数字），判不了对不对题——
// 实测搜索会混进词典单字页、百科消歧义页、同名词撞车的政府页（地名/人名碰巧含检索词）。
// 数量闸门之前先用一次 LLM 批量调用逐条剔除跑题页；任何异常 fail-open 保留机器初筛结果。
async function judgeRelevance(
  units: RelevanceUnit[],
  llm: (prompt: string) => Promise<string>
): Promise<void> {
  const live = units.filter((u) => u.facts.length > 0);
  if (!live.length) return;
  const blocks = live
    .map((u) => {
      const lines = u.facts
        .map(
          (f, i) =>
            `[${i}] 标题：${f.title}｜站点：${hostOf(f.url) || "未知"}｜摘要：${
              f.snippet || "（无摘要）"
            }`
        )
        .join("\n");
      return `[id:${u.id}]
要找的方向：${u.label}
该方向与眼前事件的关系：${u.reason}
检索问题：${u.queries.join(" / ")}
候选网页：
${lines}`;
    })
    .join("\n\n");
  const prompt = `你是"取证验真员"。下面给出若干个【查找方向】，每个方向挂了搜索引擎返回的候选网页（标题+站点+摘要）。
你的唯一任务：逐条判断每个网页是否【真的能作为该方向的证据】。

判为相关（保留）的情形——满足任一即可：
1. 网页主题就是检索问题要找的内容：具体统计数据/比例、具体历史事件的报道或正式处理结果；
2. 学术方向：标题或摘要明确出现该理论/学派/研究者/研究项目/论文的名称或其核心命题（论文列表页、期刊页、知网/学术聚合页、研究者个人主页列出对题论文，都算；百度跳转链接只要标题对题也算）；
3. 百科/词条页：词条主题本身就是被检索的概念、理论、事件、研究项目或人物本人（例如查"电池热失控"命中的"电池热失控"词条算；只命中其中一个泛义词的不算）；
4. 高校/科研机构/政府页面：摘要明确列出了与检索目标同名的研究项目、课题、统计公报或政策。

必须剔除的情形：
- 字词词典页、百科的单字/消歧义页、网站或频道/栏目首页、软件下载或使用教程页；
- 同名词撞车：标题含检索词但其实是无关的地名、人名、机构名、商品名、无关旧闻；
- 自媒体随感、论坛帖、营销号、个人学习笔记冒充统计数据或学术理论；
- 摘要与检索问题只有字词重合、主题对不上。

判断以标题+摘要的实际内容为准，不要因为来源不权威就误杀——来源档次由后续闸门负责，你只负责"对不对题"。拿不准才不保留。

只返回一个 JSON 对象，不要解释、不要 markdown 代码块：
{"keep":{"方向id":[保留的网页序号,...]}}
网页序号从 0 开始；某方向全部不合格就给空数组。

【待判定方向】
${blocks}`;
  let raw: string;
  try {
    raw = await llm(prompt);
  } catch (e) {
    console.warn("[association] 相关性验真 LLM 失败，fail-open 保留机器初筛:", (e as Error)?.message || e);
    return;
  }
  const txt = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return;
  }
  const keepMap = (parsed as { keep?: unknown })?.keep;
  if (!keepMap || typeof keepMap !== "object") return;
  for (const u of live) {
    const arr = (keepMap as Record<string, unknown>)[u.id];
    if (!Array.isArray(arr)) continue; // 模型漏判该单元：fail-open 不动它
    const keepIdx = new Set(
      arr
        .filter((x): x is number => Number.isInteger(x) && x >= 0 && x < u.facts.length)
    );
    u.facts = u.facts.filter((_, i) => keepIdx.has(i));
  }
}

// 预取证：proposal 阶段给所有轴/成因方向并行跑闸门，结果挂在轴上供前端勾选置灰。
// 成因各方向也全部取证（缓存由此变热，用户选定后 generate 再取几乎零成本）。
// 管线：检索机器初筛 → LLM 相关性验真（剔除跑题页）→ 数量闸门。
export async function gatherProposalEvidence(
  axes: AssociationAxis[],
  llm: (prompt: string) => Promise<string>
): Promise<AssociationAxis[]> {
  if (!axes.length) return [];
  type Job = {
    unit: RelevanceUnit;
    kind: AssociationKind;
    raw: number;
    machine: number;
    apply: (f: AssociationFact[]) => void;
  };
  const jobs: Job[] = [];
  for (const axis of axes) {
    if (axis.kind === "explanation") {
      for (const st of axis.stances || []) {
        const unit: RelevanceUnit = {
          id: st.id,
          label: st.stance,
          reason: st.reason,
          queries: st.queries,
          facts: [],
        };
        jobs.push({
          unit,
          kind: "explanation",
          raw: 0,
          machine: 0,
          apply: (f) => {
            st.gate = unitGate("explanation", f) ? "pass" : "fail";
            st.evidenceCount = f.length;
            st.sampleTitles = f.slice(0, 2).map((x) => x.title);
            st.evidenceSamples = f.map((x) => ({ title: x.title, url: x.url }));
            st.verifiedFacts = f;
          },
        });
      }
    } else if (axis.queries?.length) {
      const unit: RelevanceUnit = {
        id: axis.id,
        label: axis.axis,
        reason: axis.reason,
        queries: axis.queries,
        facts: [],
      };
      jobs.push({
        unit,
        kind: axis.kind,
        raw: 0,
        machine: 0,
        apply: (f) => {
          axis.gate = unitGate(axis.kind, f) ? "pass" : "fail";
          axis.evidenceCount = f.length;
          axis.sampleTitles = f.slice(0, 2).map((x) => x.title);
          axis.evidenceSamples = f.map((x) => ({ title: x.title, url: x.url }));
          axis.verifiedFacts = f;
        },
      });
    }
  }
  await Promise.all(
    jobs.map(async (j) => {
      const r = await gatherUnit(j.unit.queries, j.kind);
      j.raw = r.raw;
      j.unit.facts = r.facts;
      j.machine = r.facts.length;
    })
  );
  // 一次批量调用判全部单元的相关性，判完才允许上数量闸门
  await judgeRelevance(
    jobs.map((j) => j.unit),
    llm
  );
  for (const j of jobs) {
    j.apply(j.unit.facts);
    // 取证漏斗：原始去重命中 → 形态过滤后候选 → LLM 验真后 → 闸门。定位"查不到"卡在哪一层用。
    console.warn(
      `[association漏斗] ${j.unit.id}[${j.kind}] 原始命中=${j.raw} 形态候选=${j.machine} 验真通过=${j.unit.facts.length} 闸门=${
        unitGate(j.kind, j.unit.facts) ? "pass" : "fail"
      } q=${(j.unit.queries[0] || "").slice(0, 30)}`
    );
  }
  return axes;
}

// 按创作者勾选渲染证据块。cachedAxes 是 propose 阶段存在服务端缓存里的完整轴（含
// verifiedFacts）：命中的单元直接复用当时已验真的事实，不再二次联网/验真——用户勾选时
// 看到的证据就是写进稿里的证据，二次检索波动无法静默抹掉已确认方向。未命中的单元
// （老客户端/缓存过期/容器重启）照旧重新取证+验真，fail-open。
// selectedOnly 之外的方向对模型完全不可见；explanation 轴选定 stance 主打、
// 其余过闸门方向作为必须回应的反方。
export async function renderSelectedBlock(
  plan: AssociationAxis[],
  selection: AssociationSelection,
  llm: (prompt: string) => Promise<string>,
  cachedAxes?: AssociationAxis[] | null
): Promise<{ block: string; sources: { title: string; url: string }[] }> {
  // 按轴/方向 id 建缓存事实索引（缓存轴的 id 与 plan 已由调用方核对一致）
  const cachedById = new Map<string, AssociationFact[]>();
  for (const a of cachedAxes || []) {
    if (a.verifiedFacts?.length) cachedById.set(a.id, a.verifiedFacts);
    for (const s of a.stances || []) {
      if (s.verifiedFacts?.length) cachedById.set(s.id, s.verifiedFacts);
    }
  }
  const chosen = new Set(selection.axisIds);
  const picked = plan.filter((a) => chosen.has(a.id) && a.kind !== "explanation");
  const expl = plan.find((a) => chosen.has(a.id) && a.kind === "explanation");

  const sections: string[] = [];
  const sources: { title: string; url: string }[] = [];
  const seenSrc = new Set<string>();
  const pushSrc = (f: AssociationFact) => {
    const key = normUrl(f.url);
    if (seenSrc.has(key)) return;
    seenSrc.add(key);
    sources.push({ title: f.title, url: f.url });
  };
  const factLines = (facts: AssociationFact[]): string =>
    facts
      .map(
        (f, j) =>
          `  证据-${j + 1}${f.authority ? "[权威源]" : ""}：${f.title}｜${f.snippet}${
            f.published ? `（${String(f.published).slice(0, 10)}）` : ""
          }\n  链接：${f.url}`
      )
      .join("\n");

  // 所有选中单元先并行检索，再统一做一次相关性验真（与 proposal 阶段同口径），最后各自过闸门
  const axisUnits: { axis: AssociationAxis; unit: RelevanceUnit }[] = picked.map((a) => ({
    axis: a,
    unit: { id: a.id, label: a.axis, reason: a.reason, queries: a.queries || [], facts: [] },
  }));
  let stanceUnits: { stance: AssociationStance; unit: RelevanceUnit }[] = [];
  let mainStance: AssociationStance | null = null;
  if (expl?.stances?.length) {
    const byId = new Map(expl.stances.map((s) => [s.id, s]));
    mainStance = byId.get(selection.stanceByAxis?.[expl.id] || "") || null;
    const wantStances = mainStance
      ? [mainStance, ...expl.stances.filter((s) => s.id !== mainStance!.id)]
      : [];
    stanceUnits = wantStances.map((s) => ({
      stance: s,
      unit: { id: s.id, label: s.stance, reason: s.reason, queries: s.queries, facts: [] },
    }));
  }
  // 命中缓存的单元直接取 propose 阶段已验真事实（拷一份防下游改动污染缓存）；
  // 未命中的单元才并行联网检索。之后只对新检索的单元补做一次批量验真。
  const allUnits: RelevanceUnit[] = [];
  const freshUnits: RelevanceUnit[] = [];
  await Promise.all([
    ...axisUnits.map(async (x) => {
      const hit = cachedById.get(x.unit.id);
      if (hit) {
        x.unit.facts = hit.map((f) => ({ ...f }));
      } else {
        x.unit.facts = (await gatherUnit(x.unit.queries, x.axis.kind)).facts;
        freshUnits.push(x.unit);
      }
      allUnits.push(x.unit);
    }),
    ...stanceUnits.map(async (x) => {
      const hit = cachedById.get(x.unit.id);
      if (hit) {
        x.unit.facts = hit.map((f) => ({ ...f }));
      } else {
        x.unit.facts = (await gatherUnit(x.unit.queries, "explanation")).facts;
        freshUnits.push(x.unit);
      }
      allUnits.push(x.unit);
    }),
  ]);
  if (freshUnits.length) {
    await judgeRelevance(freshUnits, llm);
  }
  if (cachedById.size) {
    console.warn(
      `[association缓存] 复用已验真单元=${allUnits.length - freshUnits.length} 重新取证单元=${freshUnits.length}`
    );
  }

  // data / precedent 轴
  for (const { axis: a, unit } of axisUnits) {
    const facts = unit.facts;
    if (!unitGate(a.kind, facts)) continue; // 二次确认，防止勾选后缓存/源波动
    facts.forEach(pushSrc);
    if (a.kind === "data") {
      sections.push(`■ 数据背景：${a.axis}\n  与眼前事件的关系：${a.reason}\n${factLines(facts)}`);
    } else {
      sections.push(`■ 同类先例：${a.axis}
  与眼前事件的关系：${a.reason}
  下列检索结果可能包含【同一事件的多篇报道】——动笔前你必须先自行合并：同一事件只保留一条，逐条写清「时间＋事件经过＋处理结果/结局＋来源类型」。检索到几个不同事件就写几个，不许凑数，不许补资料里没有的细节：
${factLines(facts)}`);
    }
  }

  // explanation 轴：主打方向 + 其余过闸方向作反方（验真后的事实）
  if (mainStance) {
    const mainFacts =
      stanceUnits.find((x) => x.stance.id === mainStance!.id)?.unit.facts || [];
    if (unitGate("explanation", mainFacts)) {
      mainFacts.forEach(pushSrc);
      const counterBlocks: string[] = [];
      for (const { stance: s, unit } of stanceUnits) {
        if (s.id === mainStance.id) continue;
        const f = unit.facts;
        if (unitGate("explanation", f)) {
          f.forEach(pushSrc);
          counterBlocks.push(`  - ${s.stance}（${s.reason}）\n${factLines(f)}`);
        } else {
          // 未取到公开证据的对立方向：只许点出角度并承认无据，严禁替它编论据
          counterBlocks.push(
            `  - ${s.stance}（${s.reason}）【本次未检索到可靠公开依据：稿中最多一句话点出这个质疑角度并明说缺少公开依据，严禁替它编造任何论据】`
          );
        }
      }
      sections.push(`■ 成因剖析：${expl!.axis}
  与眼前事件的关系：${expl!.reason}
  ★ 创作者选定的主打解释（这是创作者的立场，你的任务是为它找证据、论证扎实）：${mainStance.stance}
    ${mainStance.reason}
    支撑证据：
${factLines(mainFacts)}
  ◇ 必须在稿中真实出现并被回应的其他解释：
${counterBlocks.join("\n") || "  （无）"}`);
    }
  }

  if (!sections.length) return { block: "", sources };

  // 是否选了成因方向决定联想的"戏份"：只选数据/先例时联想是配菜(≤1/3)；
  // 用户勾了成因=明确要往深挖，联想升为主线之一(约一半)，但仍要锚回眼前具体人事防空泛。
  const hasExpl = sections.some((s) => s.startsWith("■ 成因剖析"));
  const shareRule = hasExpl
    ? `- 戏份（用户特意勾了成因方向、要你往深挖）：上面的结构联想（数据背景/同类先例/成因剖析合计）要成为本稿中段的主体，总字数约占全稿的【一半（40%-50%）】；其中★主打成因必须用一整个层次论证扎实，不能一句话带过；但开头3秒仍从眼前这件具体的事切入，每讲完一个方向立刻拉回眼前当事人，结尾必须落在这件事的具体场景上，严禁停在宏大概念喊口号或升华；`
    : `- 戏份：本次只勾了数据/先例，联想是配菜不是主菜，相关内容总字数【不超过全稿三分之一】；点到即止、随时落回眼前这件事；`;

  const block = `

【结构联想证据（服务端刚刚联网检索所得，仅本条开启联想增强时存在）】
以下是从眼前事件发散、并经创作者勾选确认的联想方向，全部为真实公开资料：
${sections.join("\n\n")}

使用纪律（违反任意一条即为不合格稿）：
- 必须真实用上，不许晾着：上面列出的【每一个】■方向（数据背景/同类先例/成因剖析）在成稿里都必须至少有一处【带出处的实质引用】——数据轴要落到具体数字、先例轴要落到具体的别的事件、成因轴要落到具体研究/学者/假说；严禁整块缺席、严禁只在开头点个方向名却不给料；
- 关联不是因果：只能用"放在这个背景下看""这件事不是孤例""有一派解释认为"的方式连接，严禁写成"就是这个原因/结构导致了眼前这件事"；
- 数字、年份、事件时间照抄原文并交代来源类型（官方统计/学术研究/媒体报道）与年份；资料里没有的结论、细节、人名、数据一律不许补；
- 写同类先例时，每个先例必须同时写出"与眼前事件的相似处"和"不同处"；严禁"性质完全相同/都一样/本质一样"式抹平差异的归纳；
- 成因假说是解释不是定论：措辞用"这一解释认为/有研究指出"，不得写成公认事实；每个因果判断必须挂具体研究/学者/出处，严禁"众所周知/一直以来/很多人觉得"式无出处断言；
- 对反方解释必须先如实摆出它在上面资料中的最强论据，再回应；把反方写得很蠢再驳（稻草人）算不合格；
- 严禁揣测眼前事件【具体当事人】的心理、成长经历或动机（如"他小时候一定怎样"）；成因剖析只停在群体机制层；
- 无据方向不许借料冒充：标注【未检索到可靠公开依据】的那个方向，最多一句话点出角度并明说"目前缺少公开依据"，严禁拿论据库里的故事/数字去充当它的证据；
- 假说必须点名：写到★主打解释或任何有证据的对立解释时，要明确点出它的出处（如"经济学家贝克尔把生育视为家庭决策""某某研究/学者指出"），不许把理论结论改写成你自己的无主断言；
- 只许写上面列出的方向，严禁自己再顺着发散别的宏观结论；
${shareRule}
- 交稿前数字倒查（必做动作）：把成稿里出现的【每一个】百分比、金额、人数、年份、"X%"逐个回对上方的【原文摘录】和【证据-N】，只有能逐字找到出处的才许保留；任何对不上的数字立刻删掉该句——哪怕你印象里"真实存在/大概是这个数"也不许写，更不许用"有研究显示/数据表明/大约"给无出处数字糊包装；联想部分要的是用【上方已给出的证据】论证，不是凭常识补料。`;
  return { block, sources };
}

// 一步兜底（无方向卡/测试直调）：发散 → 全量预取证 → 自动默认选择
// （数据/先例过闸全选；成因选第一个过闸方向主打，其余过闸方向自动作反方）。
export async function buildAssociationMaterial(
  topic: string,
  thesis: string,
  llm: (prompt: string) => Promise<string>
): Promise<AssociationResult> {
  const empty: AssociationResult = { axes: [], evidence: [], block: "", sources: [] };
  try {
    const axes = await proposeAssociationAxes(topic, thesis, llm);
    if (!axes.length) return empty;
    await gatherProposalEvidence(axes, llm);
    const axisIds: string[] = [];
    const stanceByAxis: Record<string, string> = {};
    for (const a of axes) {
      if (a.kind === "explanation") {
        const first = (a.stances || []).find((s) => s.gate === "pass");
        if (first) {
          axisIds.push(a.id);
          stanceByAxis[a.id] = first.id;
        }
      } else if (a.gate === "pass") {
        axisIds.push(a.id);
      }
    }
    if (!axisIds.length) return { axes, evidence: [], block: "", sources: [] };
    // 刚取完证：把含 verifiedFacts 的 axes 当缓存传入，render 直接复用，不再二次检索
    const { block, sources } = await renderSelectedBlock(
      axes,
      { axisIds, stanceByAxis },
      llm,
      axes
    );
    return { axes, evidence: axes.filter((a) => a.gate === "pass"), block, sources };
  } catch (e) {
    console.warn("[association] 联想增强整体失败，回退普通稿:", (e as Error)?.message || e);
    return empty;
  }
}
