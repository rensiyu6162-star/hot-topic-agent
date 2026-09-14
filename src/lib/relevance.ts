// 标题/查询相关性的零成本词面门控（不依赖 LLM），三处共用同一口径：
//  crawler.ts 自建爬虫合并、searx.ts union 权威分桶、chat/route.ts 合并层与 refs 收口。
// 另含"问题题型"判定：只有定义/政策/人物类问题才把权威源当刚需，
// 玩梗/娱乐/竞技类问题不硬补权威（社区帖才是对口来源）。

const TITLE_STOP_CHARS = new Set(
  "什么是的了吗呢啊咋怎谁哪为何意思由来最近这那个里被把让给和与及或在有无不没很太真就都也还又再会能可要想说看做去来到上下中我们你们他她它"
);

// ctxWords（2026-09）：queryPlan 给出的语境限定词（来自用户问句本身，如
// "X中的Y"里的 X、四位年份）。带语境的查询，标题只撞到一个泛词 2-gram 不算相关，
// 必须：命中≥2 个实义 gram，或语境词也在场。纯结构规则，不含任何领域词表。
// 不带语境词的查询（降准/苹果18抢不到）维持旧口径：单 2-gram 命中即放行。
export function titleRelevant(
  title: string,
  query: string,
  ctxWords: string[] = []
): boolean {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  // A不A 句式（city不city / 懂不懂）：完整句式本身就是强锚点，优先级最高，
  // 命中即相关、不命中即串味——专治虎扑把 city 当曼城(Man City)召回
  const dupEn = q.match(/([a-z][a-z0-9]*)不\1/);
  if (dupEn) {
    const w = dupEn[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${w}\\s*不\\s*${w}`).test(t);
  }
  const dupCjk = q.match(/([一-鿿])不\1/);
  if (dupCjk) return t.includes(`${dupCjk[1]}不${dupCjk[1]}`);

  const cjk = (q.match(/[一-鿿]+/g) || []).join("");
  const engWords = q.match(/[a-z][a-z0-9]+/g) || [];
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const g = cjk.slice(i, i + 2);
    if (!TITLE_STOP_CHARS.has(g[0]) && !TITLE_STOP_CHARS.has(g[1]))
      grams.add(g);
  }
  let gramHits = 0;
  for (const g of grams) if (t.includes(g)) gramHits++;
  const ctxHit = ctxWords.some((w0) => {
    const w = w0.toLowerCase();
    if (!w) return false;
    if (/^[a-z0-9]{2,}$/.test(w))
      return new RegExp(
        `(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`
      ).test(t);
    return t.includes(w);
  });
  if (gramHits >= 2) return true;
  if (gramHits === 1) return ctxWords.length === 0 || ctxHit;
  if (cjk.length && engWords.length) {
    // 中英混合查询：要求"查询内中字+英文词"紧邻拼接（如 iPhone发布）
    for (const w of engWords) {
      const re = new RegExp(`[一-鿿]${w}|${w}[一-鿿]`);
      const m = t.match(re);
      if (m && cjk.includes(m[0].replace(/[a-z]/g, ""))) return true;
    }
  }
  if (engWords.length) {
    // 纯英文查询，或中文部分全是虚词（Cursor 是什么）：英文整词命中即可
    return engWords.some((w) =>
      new RegExp(
        `(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`
      ).test(t)
    );
  }
  return grams.size === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用查询拆解 queryPlan（2026-09）：所有检索入口（detail/chat/searx/crawler）的统一第一步。
// 不管 query 来自热榜短标题（"苹果18抢不到"）还是用户问句（"cs中的研发芯片是什么梗"），
// 检索词必须是【剥掉疑问句式、保留语境限定词的短短语】：
//   "cs中的研发芯片是什么梗" → main "cs 研发芯片"（context: cs）
//   "什么是降准"             → main "降准"
//   "苹果18抢不到"           → main "苹果18抢不到"（热榜标题原样）
// 不做这步的三个实锤后果：①中文整句无空格，varyQuery 截词完全失效，平台内搜索零召回；
// ②引擎把整句当"查字典"，返回词典/翻译/泛行业页（搜梗回来一整页半导体芯片）；
// ③跑偏召回里的高频泛词（芯片/研发）被 guessEntity 误猜成主体，整条链路越跑越偏。
export type QueryPlan = {
  // 主检索短语：剥疑问壳、"X中的Y"展平为"X Y"，其余实词（含年份/代际）全部保留
  main: string;
  // 裸短语：再去掉独立语境词（cs/nba 等），用于百科/权威源召回；与 main 相同则省略
  bare: string;
  // 语境限定词：从句法结构里抽出的限定成分——"X中的/里/圈的Y"里的 X、四位年份、
  // 与中文短语并列的独立英文/数字词（cs、nba）。全部来自用户原句，不做任何领域推断。
  // 用于门控"单泛词撞车"（标题只含"研发"不含"芯片"也不含 X → 沉底）。
  context: string[];
  // 召回补搜变体（内容中立）：用户问句尾部自带的【分类名词】（梗/意思/由来/出处/定义…）
  // 原样拼回裸短语补一发检索——"X是什么梗"补"X 梗"、"X的由来"补"X 由来"，
  // 用的是用户自己的词，不掺入任何我们猜测的答案或别名。
  extra: string[];
  // 原 query 是否为概念提问（定义/梗/意思/由来）——这类查询禁用"从召回猜实体"
  isConceptAsk: boolean;
  // 题型：用户自己写明问的是【民间话语】（梗/黑话/名场面/外号/段子…），与 isDefinitionQuery
  // 同属"按用户原句用词做的题型分类"，不是领域词表。这类问题的对口来源是社区讨论帖，
  // 权威/政府网页几乎不可能有答案，召回排序时社区桶前置（不删任何结果）。
  folkAsk: boolean;
};

const POLITE_HEAD_RE =
  /^(请问一下|请问|谁知道|大家知道|有没有人知道|我想知道|想问一下|想问下|问一下)[，,]?\s*/;
// 尾部疑问框架：先长后短，"是什么梗"必须在"是什么"之前
const ASK_TAIL_RE =
  /(到底|究竟|来着|的说|呀)?(是什么梗|啥是个梗|啥是梗|什么梗|啥梗|的梗|是什么意思|啥意思|什么意思|是啥意思|是什么|是啥个|是啥|是谁|怎么样|咋样|怎样|为什么|为啥|为何|怎么回事|啥情况|什么情况|什么来头|啥来头|的定义|的由来|的出处|的来源|的起源|的意思)[?？!！啊呀吗呢嘛哦哦\s]*$/;
// 头部疑问词（stripSubject 之外的补充：怎么/为什么/咋）
const ASK_LEAD_RE = /^(为什么|为何|怎么|咋|如何)(?=[一-鿿a-z0-9])/;
// "X中的Y / X里的Y / X圈的Y"：X 是必须保留的语境限定词（cs 中的研发芯片、NBA 里的规则）
// 中文前缀要求≥2字：单字（哪里/梦里/家里/心里）当语境词纯属噪声
const SCOPE_RE =
  /([A-Za-z][A-Za-z0-9]{0,15}|[一-鿿0-9]{2,10})(?:之中|当中|中的|里的|圈内|圈里|圈的|吧的|吧里|里)/g;

export function queryPlan(q: string): QueryPlan {
  const s0 = (q || "").trim();
  const isConceptAsk =
    isDefinitionQuery(s0) ||
  /(什么梗|啥梗|的梗|黑话|什么意思|啥意思|网络用语|网络热词|俚语|梗的?(由来|出处|来源|起源)|名场面)/.test(
      s0
    );

  let s = s0
    .replace(POLITE_HEAD_RE, "")
    .trim();
  // stripSubject 负责"什么是X / X是谁 / X是什么意思"；再补剥尾部疑问框架
  s = stripSubject(s);
  s = s.replace(ASK_TAIL_RE, "").trim();
  s = s.replace(ASK_LEAD_RE, "").trim();
  // 疑问引导动词："怎么看待X / 如何评价X" 剥完疑问词后它们还挂在头上
  s = s.replace(/^(看待|如何看|怎样看|评价一下|评价下|评价|理解)/, "").trim();
  s = s.replace(/[?？!！\s]+$/, "").trim() || s0.replace(/\s+/g, " ").trim();

  // 语境词①："X中的/里/圈"结构的 X
  const context: string[] = [];
  const pushCtx = (w: string) => {
    const k = w.toLowerCase();
    if (k && !context.includes(k)) context.push(k);
  };
  let m: RegExpExecArray | null;
  SCOPE_RE.lastIndex = 0;
  while ((m = SCOPE_RE.exec(s))) {
    const w = m[1];
    if (/^(这个|那个|这些|那些|里面|其中|现实|生活|历史|国内)$/.test(w)) continue;
    pushCtx(w);
  }
  // 语境词②：四位年份（2024 年的旧事件不能混进新热点时间线，年份是强区分词）
  const yearM = s.match(/(?:19|20)\d{2}/);
  if (yearM) pushCtx(yearM[0]);
  // 语境词③：中文短语里出现的拉丁 token，只认【结构上独立】的——它与汉字之间隔着
  // 空格/标点/范围助词（中/里/圈/吧/的）。与汉字直接胶着的（iPhone18、A20Pro、
  // MateXT 这类产品型号）是短语主体的一部分，不当语境词。纯结构判定，不维护任何
  // 品牌/型号词表。纯英文查询（无中文短语）整体跳过。
  const SCOPE_PARTICLE = new Set(["中", "里", "圈", "吧", "的"]);
  const LATIN_RE = /[A-Za-z][A-Za-z0-9]{1,15}/g;
  if (/[一-鿿]{2,}/.test(s)) {
    let lm: RegExpExecArray | null;
    while ((lm = LATIN_RE.exec(s))) {
      const before = s[lm.index - 1] || "";
      const after = s[lm.index + lm[0].length] || "";
      const gluedCJK =
        (/[一-鿿]/.test(before) && !SCOPE_PARTICLE.has(before)) ||
        (/[一-鿿]/.test(after) && !SCOPE_PARTICLE.has(after));
      if (!gluedCJK) pushCtx(lm[0]);
    }
  }

  // main：展平"中的/里/圈"为空格，清标点，压空白
  let main = s
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。！!？?~—\-*#]/g, " ")
    .replace(/(之中|当中|中的|里的|圈内|圈里|圈的|吧的|吧里)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!main) main = s0.replace(/\s+/g, " ").trim();

  // bare：去掉独立英文语境词后的裸短语（"cs 研发芯片"→"研发芯片"）；
  // 去完不成词（A不A 句式、纯英文查询）则 bare=main。
  let bare = main;
  for (const w of context) {
    if (/^[a-z][a-z0-9]{0,15}$/.test(w)) {
      bare = bare
        .replace(new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, "gi"), " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  if (bare.length < 2) bare = main;

  // 召回补搜（内容中立，唯一规则：把用户自己写下的分类名词带回检索短语）：
  // 尾部疑问壳被剥掉后，"梗/意思/由来/出处/定义"这类分类信息也丢了，而它恰恰
  // 决定引擎召回方向（"X 梗"召回玩梗帖，"X 由来"召回溯源帖）。原样拼回裸短语即可，
  // 不做任何领域推断、不加任何别名。
  const extra: string[] = [];
  const catM = s0.match(
    /(什么意思|啥意思|网络用语|网络热词|名场面|黑话|俚语|热词|梗|定义|由来|出处|来源|起源)/
  );
  if (catM) {
    const cat = catM[0] === "什么意思" || catM[0] === "啥意思" ? "意思" : catM[0];
    // 剥壳后 main 里仍带着该分类词（"if梗的来源"→main"if梗"）就不重复补
    if (!main.replace(/\s+/g, "").includes(cat)) {
      const x = `${bare} ${cat}`.replace(/\s+/g, " ").trim();
      if (
        x.replace(/\s+/g, "").toLowerCase() !==
        main.replace(/\s+/g, "").toLowerCase()
      )
        extra.push(x);
    }
  }

  // 民间话语题型：只看用户自己写下的分类名词；"梗概/梗死/梗咽"等非分类用法排除
  const folkAsk =
    /(梗(?!概|塞|咽|死)|黑话|名场面|网络用语|网络热词|俚语|热词|段子|玩梗|外号|绰号|昵称|土味)/.test(
      s0
    );

  return { main, bare, context, extra, isConceptAsk, folkAsk };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主体名提取守卫（2026-09 实锤事故修复）：模型偶发不遵守"【主体速览】紧跟一句大白话"
// 的格式，把正文另起一行（"【主体速览】\n已核实资料显示，bl（Boys' Love）…"），
// 前端旧正则 \s* 会跨过换行抓住叙事句，又在第一个逗号处切断，主体名变成"已核实资料显示"，
// 随后污染详情/脚本链路的全部检索词（服务器日志实锤 q=已核实资料显示 腐女）。
// 两道内容中立工序（只认句式/字符结构，不含任何领域词）：
//   ① extractEntityFromOverview：从容错的速览文本里提取主体名，拿不到可靠名返回 ""；
//   ② sanitizeEntityCandidate：校验调用方传入的主体名是不是叙事残句，是则清空。
// 宁空勿错：空名会退回到 queryPlan 概念检索路径，比错主体安全得多。

// 叙事/引述模板前缀（纯句式，非领域词）：模型在速览开头交代检索情况时的高频起手式
const NARRATIVE_LEAD_RE =
  /^(?:已核实(?:的)?资料显示|核实(?:的)?资料显示|资料显示|根据(?:公开|现有|已有)?资料(?:显示|记载|表明|介绍)?|据(?:公开|现有|已有)?资料(?:显示|记载|表明|介绍)?|公开资料显示|经查?(?:实|证|明)?(?:资料|公开资料)?(?:显示)?|经核实(?:的)?资料显示|简单来说|简单说|总体来说|总的来说|也就是说|换句话说|据悉|据了解|据介绍|近日|日前|话说|说起来)[，,：:、\s]*/;

// 提取后仍是叙事性短语的起手特征（时空/泛指示开头，不可能是主体名）
const NARRATIVE_BODY_RE =
  /^(?:(?:这|那)(?:件事|种说法|个说法|类说法)|指的是|是什么|说明了?|讲的是|说的是|今日(?:相关|各平台|热榜|全网|网上)|近日|目前|网上|全网|相关(?:讨论|内容|说法|话题|热点))/;

// 切出中文专名片段时的句法停字（纯虚词/判断词单字，不含任何领域/类别词）
const CN_NAME_STOP_CHARS = new Set(
  "的了是在和与跟指属被把让给为也都就还已曾将会能可这那种么怎其之"
);

// 从候选片段中切出"主体名"：英文/数字词整体、引号内、书名号、中文连续名词片段
function pickNameFromLine(line: string): string {
  let t = (line || "").trim();
  if (!t) return "";
  // 反复剥叙事前缀（最多三轮，防"已核实…，据悉…"叠加）
  for (let i = 0; i < 3; i++) {
    const next = t.replace(NARRATIVE_LEAD_RE, "").trim();
    if (next === t) break;
    t = next;
  }
  if (!t) return "";
  // 句首书名号 → 作品名
  const book = t.match(/^《([^》]{1,30})》/);
  if (book) return book[1].trim();
  // 句首「」/引号内 → 引用的专名
  const quoted = t.match(/^[「『“"']([^」』”"']{1,30})[」』”"']/);
  if (quoted) return quoted[1].trim();
  // 句首英文/数字词（bl、Cursor、zont1x、487）：允许撇号/连字符/点
  const latin = t.match(/^[A-Za-z0-9][A-Za-z0-9'’.\-]{0,25}/);
  if (latin) return latin[0].replace(/[.'\-]+$/, "");
  // 中文：在第一个标点/判断切口处截断，再按句法停词逐字收
  const cut = t.search(/[（(，,：:、；;。！？\s]|\s是/);
  if (cut >= 0) t = t.slice(0, cut);
  let end = t.length;
  for (let i = 0; i < t.length; i++) {
    if (CN_NAME_STOP_CHARS.has(t[i])) {
      end = i;
      break;
    }
  }
  t = t.slice(0, end).replace(/《|》/g, "").trim();
  return t;
}

// 主体名合理性校验：通过则返回干净主体名，否则返回 ""
export function sanitizeEntityCandidate(raw: string): string {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  // 整串带句读 → 先试着切，不直接信任
  t = pickNameFromLine(t);
  if (!t || t.length > 40) return "";
  if (NARRATIVE_BODY_RE.test(t)) return "";
  // 单字必须是拉丁/数字（中文单字基本是误抓）
  if (t.length < 2 && !/[a-zA-Z0-9]/.test(t)) return "";
  // 只剩标点/虚词起手且无拉丁字符 → 失败
  if (!/[一-鿿a-zA-Z0-9]/.test(t)) return "";
  return t;
}

// 从【主体速览】正文块提取核心主体名（前端解析模型回复用）：
// 容错点——标记可能独占一行、标记行可能带尾巴、第一行可能是叙事句。
// 依次尝试速览开头的前几个非空行，第一个能取出可靠专名的即返回；全部失败返回 ""。
export function extractEntityFromOverview(content: string): string {
  if (!content) return "";
  const m = content.match(/【主体速览】([\s\S]*?)(?:\n[^]*?(?:直接相关的切入|相关领域的切入)|$)/);
  if (!m) return "";
  // 只看速览开头 160 字，避免后文正文里的书名/专名喧宾夺主
  const head = m[1].slice(0, 160);
  const lines = head
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  for (const ln of lines) {
    const name = sanitizeEntityCandidate(pickNameFromLine(ln));
    if (name) return name.slice(0, 40);
  }
  return "";
}

// 定义/政策/人物类问题判定（2026-09）：这类问题权威源（政府/央媒/百科）是刚需，
// 引擎抖空时值得补一发；"什么梗/名场面/怎么火"等娱乐竞技类问题不在此列。
export function isDefinitionQuery(q: string): boolean {
  if (/(什么是|啥是|何为|何谓|是谁|的定义|是什么意思|啥意思|是指什么|指什么)/.test(q))
    return true;
  // "X是什么" 算定义，但 "X是什么梗/梗" 归娱乐类
  return /是什么/.test(q) && !/梗/.test(q);
}

// 剥出问题的主体词："什么是降准"→"降准"、"董宇辉是谁"→"董宇辉"、
// "Cursor是什么"→"Cursor"。剥离失败（非问句形态）时原样返回。
// 用途：整句里的虚词会干扰百科相关性匹配；引擎对裸词的权威召回也明显更好（实测）。
export function stripSubject(q: string): string {
  const s = (q || "").trim();
  let out = s
    .replace(
      /^(请问一下|请问|谁知道|大家知道|有没有人知道|我想知道|想问一下|想问下|问一下)[，,]?\s*/,
      ""
    )
    .replace(/^(到底|究竟|来说?|具体)?(什么是|啥是|何为|何谓)/, "")
    .replace(
      /(到底|究竟)?(是什么意思|啥意思|是什么|是谁|的定义|是指什么|指什么)[?？!！\s]*$/,
      ""
    )
    .replace(/[?？!！\s]+$/, "")
    .trim();
  return out || s;
}
