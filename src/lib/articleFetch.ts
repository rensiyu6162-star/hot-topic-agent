// 网页正文抓取（2026-09 新增，零第三方依赖）
//
// 背景：搜索引擎只给「标题 + 链接 + ≤150字快照」，写稿模型长期吃不到原文，
// 长稿只能兑水/脑补。本模块在用户点「生成脚本」时对少量链接（默认≤5篇）
// 实时抓全文：
//   · 新闻/门户/政府/论坛公开直出页 → HTTP 直接抓，正文密度抽取
//   · 微博 → m.weibo.cn 公开 JSON 接口（免登录）
//   · 封死的域（知乎/贴吧/小红书/抖音/豆瓣/百度系）→ 不敲门，静默退回快照
// 规则全部按「域名形态/页面结构」中立判定，不含任何话题词表。
//
// 工程约束：
//   · 纯结构机制：单篇 8s 超时、整体并发 6、失败静默降级，绝不阻塞写稿主链路
//   · 只抓公开直出页，不绕验证码/登录墙（合规：不碰技术屏障）
//   · 不存库、不二次分发全文，只作为当次写稿的事实依据
//   · 进程内缓存 30 分钟，同一篇不重复敲门

export type ArticleLink = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  date?: string;
};

export type FetchedDoc = {
  url: string;
  title: string;
  source: string;
  date?: string;
  full: boolean; // true=全文抓取成功；false=退回快照/摘要
  text: string; // 全文（已截到上限）或快照文本
  cn: number; // text 内中文字数
};

const FETCH_TIMEOUT_MS = 8000;
const MAX_FULL = 5;
const ART_CAP = 1800; // 单篇新闻/长文截取上限
const SOCIAL_CAP = 900; // 社交帖（微博等）截取上限
const CACHE_TTL_MS = 30 * 60 * 1000;

// ───────────────────────── 域名策略 ─────────────────────────

// 实测（2026-09 腾讯云服务器）对一切非登录姿势封死的域：
// HTTP 直连 403/418、公开页空壳或整域风控。敲门纯属浪费 8 秒，直接退回快照。
const BLOCKED_FETCH_RE =
  /(?:^|\.)zhihu\.com|(?:^|\.)zhihu\.com\.(?:cn|com)|tieba\.baidu\.com|(?:^|\.)baike\.baidu\.com|wenku\.baidu\.com|baijiahao\.baidu\.com|mbd\.baidu\.com|(?:^|\.)baidu\.com\/s|(?:^|\.)douban\.com|(?:^|\.)xiaohongshu\.com|(?:^|\.)xhsearch\.com|(?:^|\.)douyin\.com|(?:^|\.)iesdouyin\.com|(?:^|\.)jinritemai\.com/i;

// 移动 UA 才能拿到 SSR 全文的站（PC 版是空壳 SPA）；新浪系则相反，要 PC UA。
const MOBILE_UA_RE = /(?:^|\.)toutiao\.com|(?:^|\.)new\.qq\.com|(?:^|\.)m\.weibo\.cn/i;
const PC_UA_RE = /(?:^|\.)sina(?:\.com)?\.cn|(?:^|\.)weibo\.com/i;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function uaFor(url: string): string {
  if (MOBILE_UA_RE.test(url)) return MOBILE_UA;
  if (PC_UA_RE.test(url)) return DESKTOP_UA;
  return DESKTOP_UA;
}

// 链接规范化：把 PC 空壳链接改写成能直出全文的移动形态
function rewriteUrl(raw: string): string {
  let u = raw;
  // www.toutiao.com/article/{id}/ → m.toutiao.com/i{id}/ （实测移动 SSR 有全文）
  const tt = u.match(/toutiao\.com\/(?:a|article)\/(\d+)/i);
  if (tt) u = `https://m.toutiao.com/i${tt[1]}/`;
  return u;
}

function isBlocked(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return BLOCKED_FETCH_RE.test(h) || BLOCKED_FETCH_RE.test(url);
  } catch {
    return true;
  }
}

function isWeibo(url: string): boolean {
  return /(?:^|\.)weibo\.cn|(?:^|\.)weibo\.com/i.test(url);
}

// ───────────────────────── 缓存 ─────────────────────────

const cache = new Map<string, { t: number; doc: FetchedDoc }>();

function cacheGet(url: string): FetchedDoc | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return hit.doc;
}
function cacheSet(doc: FetchedDoc) {
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(doc.url, { t: Date.now(), doc });
}

// ───────────────────────── 文本工具 ─────────────────────────

export function cnChars(s: string): number {
  const m = s.match(/[一-鿿]/g);
  return m ? m.length : 0;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16) || 0)
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 0));
}

function stripTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|td|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

function cleanLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[ \t　]+/g, " ").trim();
    if (!line) continue;
    // 导航/按钮残片：中文太少且整行很短的碎词丢掉（保留有标点的短句）
    if (cnChars(line) < 8 && !/[。！？!?]/.test(line)) continue;
    // 同一行导航词反复出现（菜单/面包屑），只留一次
    const key = line.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join("\n");
}

function capAt(text: string, cap: number): string {
  if (cnChars(text) <= cap) return text;
  // 在上限前找【最后一个】句读：宁可略短也不切半句话
  const scan = Array.from(text)
    .slice(0, Math.floor(cap * 1.6))
    .join("");
  let best = -1;
  for (const m of scan.matchAll(/[。！？!?；;…」）】]/g)) {
    const cut = (m.index || 0) + 1;
    if (cnChars(scan.slice(0, cut)) <= cap) best = cut;
  }
  if (best >= cap * 0.6) return scan.slice(0, best).trim();
  // 实在没有句读：按码位硬切（Array.from 避免截半个字符）
  return Array.from(text)
    .slice(0, cap)
    .join("")
    .trim();
}

// 登录墙/验证页/反爬拒页：抓到这类文本当失败处理
const WALL_RE =
  /登录后(?:即可|查看|继续|浏览|回复)|请先登录|登录并(?:评论|查看)|滑动(?:验证|拼图)|安全验证|验证码|访问被拒绝|拒绝访问|网络出错，请|anti[-_ ]?spider|enable javascript and|请开启 ?javascript|环境异常|完成人机验证/i;

function looksLikeWall(text: string): boolean {
  const hits = text.match(WALL_RE);
  if (hits && hits.length >= 2) return true;
  if (/403 Forbidden|Access Denied/i.test(text) && cnChars(text) < 300) return true;
  return false;
}

// ───────────────────────── HTML 正文抽取（三段式取优） ─────────────────────────

// 候选 A：<p> 段落聚合。新闻稿几乎全是 <p>，精度最高。
function extractParagraphs(html: string): string {
  const paras: string[] = [];
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripTags(m[1]).trim();
    if (!t) continue;
    if (cnChars(t) < 12 && !/[。！？!?]/.test(t)) continue;
    paras.push(t);
  }
  return cleanLines(paras.join("\n"));
}

// 候选 B：整页可见文本。论坛楼层多用 <div>，去掉结构性噪声块后按行密度收。
function extractVisible(html: string): string {
  let h = html;
  // <a> 文本保留（论坛正文常有），但整块导航/脚本/样式先删
  h = h.replace(/<(script|style|noscript|iframe|svg|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // 常见非正文容器（class/id 语义中立：导航/页头页脚/侧栏/面包屑/分享条/相关推荐）
  h = h.replace(
    /<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi,
    " "
  );
  h = h.replace(
    /<div\b[^>]*(?:class|id)="[^"]*(?:navi?gation|breadcrumb|menu|sidebar|recommend|related|footer|header|share-bar|crumb)[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    " "
  );
  return cleanLines(stripTags(h));
}

// 候选 C：JSON 数据岛。部分门户（网易 INITIAL_STATE 等）正文塞在 <script> 的
// JSON 里，DOM 文本抽取看不见。把转义还原后只捞「长中文串」，避开导航配置噪声。
function extractDataIsland(html: string): string {
  const chunks: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body.length < 200 || !/[一-鿿]/.test(body)) continue;
    // 只在像正文数据的岛里找：键名含 body/content/article/text/detail
    if (!/(?:"|')(?:body|content|articleBody|content_text|text|detail)(?:"|')\s*:/.test(body))
      continue;
    const unescaped = body
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/");
    // 捞引号内的长中文串
    for (const sm of unescaped.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      const s = stripTags(sm[1]).trim();
      if (cnChars(s) >= 30 && /[。！？!?，,；;]/.test(s)) chunks.push(s);
    }
  }
  if (!chunks.length) return "";
  // 去重（不同 JSON 路径常重复包同一正文），长块优先
  chunks.sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  let total = 0;
  for (const c of chunks) {
    if (picked.some((p) => p.includes(c) || c.includes(p))) continue;
    picked.push(c);
    total += c.length;
    if (total > ART_CAP * 3) break;
  }
  return cleanLines(picked.join("\n"));
}

function extractMainText(html: string): string {
  const a = extractParagraphs(html);
  if (cnChars(a) >= 300) return a;
  const b = extractVisible(html);
  const c = extractDataIsland(html);
  // A 不够时 B/C 选长的；B 天然带导航噪声，只比中文字数而非总长度
  return cnChars(c) > cnChars(b) ? c || b : b;
}

// ───────────────────────── HTTP ─────────────────────────

async function httpFetch(
  url: string,
  ua: string,
  extraHeaders: Record<string, string> = {}
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": ua,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        ...extraHeaders,
      },
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    // 编码：先信响应头，再信页面 meta，默认 utf-8；中文老站常见 gb2312/gbk
    let charset = "";
    const ctM = ctype.match(/charset=([\w-]+)/i);
    if (ctM) charset = ctM[1];
    if (!charset) {
      const head = buf.toString("latin1", 0, Math.min(buf.length, 4096));
      const metaM = head.match(/charset=["']?\s*([\w-]+)/i);
      if (metaM) charset = metaM[1];
    }
    const enc = /gb(?:k|2312|18030)/i.test(charset) ? "gb18030" : "utf-8";
    try {
      return new TextDecoder(enc as any).decode(buf);
    } catch {
      return buf.toString("utf-8");
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── 微博适配器 ─────────────────────────

function weiboId(url: string): string {
  const m1 =
    url.match(/m\.weibo\.cn\/(?:status|detail)\/([A-Za-z0-9]+)/i) ||
    url.match(/m\.weibo\.cn\/statuses\/show\?id=([A-Za-z0-9]+)/i) ||
    url.match(/weibo\.com\/\d+\/([A-Za-z0-9]+)/i);
  return m1 ? m1[1] : "";
}

async function fetchWeibo(url: string): Promise<string | null> {
  const id = weiboId(url);
  if (!id) return null;
  const base = `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(id)}`;
  // X-Requested-With 是实测的硬门槛（2026-09 腾讯云）：缺它一律 302 到游客通行证
  // 系统，带上后稳定 200 JSON（不登录、不绕验证码，只是表明这是站内 ajax 请求）。
  const wbHeaders: Record<string, string> = {
    Referer: "https://m.weibo.cn/",
    "MWeibo-Pwa": "1",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
  };
  const json = await httpFetch(base, MOBILE_UA, wbHeaders);
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    const d = obj?.data;
    if (!d) return null;
    let text = stripTags(String(d.text || "")).trim();
    // 长文走 extend 接口取全文
    if (d.isLongText) {
      const ext = await httpFetch(
        `https://m.weibo.cn/statuses/extend?id=${encodeURIComponent(id)}`,
        MOBILE_UA,
        { ...wbHeaders, Referer: base }
      ).catch(() => null);
      if (ext) {
        try {
          const long = JSON.parse(ext)?.data?.longTextContent;
          if (long) text = stripTags(String(long)).trim();
        } catch {
          /* 退回短文 */
        }
      }
    }
    return text || null;
  } catch {
    return null;
  }
}

// ───────────────────────── 单篇抓取 ─────────────────────────

async function fetchOne(link: ArticleLink): Promise<FetchedDoc> {
  const { title, url: rawUrl, source, date, snippet } = link;
  const fallback: FetchedDoc = {
    url: rawUrl,
    title,
    source: source || hostOf(rawUrl),
    date,
    full: false,
    text: (snippet || "").trim(),
    cn: cnChars(snippet || ""),
  };
  if (!/^https?:\/\//i.test(rawUrl)) return fallback;
  if (isBlocked(rawUrl)) return fallback;

  let text: string | null = null;
  if (isWeibo(rawUrl)) {
    text = await fetchWeibo(rawUrl);
  } else {
    const url = rewriteUrl(rawUrl);
    const html = await httpFetch(url, uaFor(rawUrl));
    if (html) {
      const extracted = extractMainText(html);
      if (!looksLikeWall(extracted)) text = extracted;
    }
  }

  // 长文 300 中文字才算抓到；社交帖（微博）本来就短，≥40 字即有效
  const minCn = isWeibo(rawUrl) ? 40 : 300;
  if (!text || cnChars(text) < minCn) return fallback;
  const capped = capAt(text, isWeibo(rawUrl) ? SOCIAL_CAP : ART_CAP);
  return {
    url: rawUrl,
    title,
    source: source || hostOf(rawUrl),
    date,
    full: true,
    text: capped,
    cn: cnChars(capped),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ───────────────────────── 选源：分桶配额（搜索推荐侧） ─────────────────────────
//
// 不按展示顺序 topN——那会被通稿转载（同稿多域名）和结构偏科（5篇全一类源）搞坏。
// 中立的三类源结构，对任何话题同一把尺：
//   authority 权威/新闻/官方媒体 → 定事实
//   community 论坛/社区          → 圈内说法与情绪（梗类话题配额上调）
//   other      其余（企业官网/博客/垂直站…）
const AUTHORITY_HOST_RE =
  /(^|\.)(gov\.cn|news\.cn|xinhuanet\.com|people\.com\.cn|people\.cn|cctv\.cn|cnr\.cn|gmw\.cn|chinanews\.com|thepaper\.cn|caixin\.com|cls\.cn|wallstreetcn\.com|yicai\.com|stcn\.com|guancha\.cn|ce\.cn|cnstock\.com|cs\.com\.cn|163\.com|sina\.com\.cn|sina\.cn|qq\.com|sohu\.com|ifeng\.com|hexun\.com|eastmoney\.com|10jqka\.com\.cn|ithome\.com|36kr\.com|zol\.com\.cn|autohome\.com\.cn|jiemian\.com|tmtpost\.com|geekpark\.net|pbc\.gov\.cn|wikipedia\.org|baike\.baidu\.com|baike\.so\.com)$/i;
const COMMUNITY_HOST_RE =
  /(^|\.)(hupu\.com|weibo\.cn|weibo\.com|nga\.cn|ngacn\.cc|v2ex\.com|reddit\.com|1point3acres\.com|guokr\.com|chiphell\.com|smzdm\.com|bbs\.io|tieba\.baidu\.com|zhihu\.com|douban\.com|xiaohongshu\.com)$/i;
// 注意：不把 m.（移动影子域）算社区——m.toutiao.com 这类是新闻移动版
const COMMUNITY_SUB_RE = /^(?:bbs|forum|club)\./i;

export type SourceClass = "authority" | "community" | "other";

function classOf(url: string): SourceClass {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "other";
  }
  if (AUTHORITY_HOST_RE.test(host)) return "authority";
  if (COMMUNITY_HOST_RE.test(host)) return "community";
  if (COMMUNITY_SUB_RE.test(host)) return "community";
  return "other";
}

export type RankedLink = ArticleLink & {
  score: number; // 调用方算好的相关度分
  fresh?: boolean; // 是否近 30 天发布
};

// 标题归一化：只留中日韩字+字母数字（转载标题常只差几个字/标点/来源后缀）
function normTitle(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

// 标题 bigram dice 相似度 ≥0.72 视为同一篇转载
function titleDup(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y || (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y)))
    return true;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter * 2 >= (gx.size + gy.size) * 0.72;
}

// 返回抓全文的优先顺序（已去重/分桶/域名限流）；拿不到的名额逐层回填。
// 下游 fetchDocs 会自己跳过封死域并把其余链接留作快照——这里不用管抓不抓得到。
export function planFetchOrder(links: RankedLink[], folkAsk = false): ArticleLink[] {
  // 去重：同 URL 留高分；转载标题留高分
  const byScore = links
    .filter((l) => l?.url && /^https?:\/\//i.test(l.url))
    .sort((a, b) => b.score - a.score);
  const dedup: RankedLink[] = [];
  for (const l of byScore) {
    if (dedup.some((d) => d.url === l.url || titleDup(d.title, l.title))) continue;
    dedup.push(l);
  }

  const domain = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "").replace(/^m\./, "");
    } catch {
      return u;
    }
  };
  const picked: RankedLink[] = [];
  const usedDomains = new Map<string, number>();
  const take = (l: RankedLink, cap: number) => {
    if (picked.includes(l)) return false;
    const d = domain(l.url);
    if ((usedDomains.get(d) || 0) >= cap) return false;
    picked.push(l);
    usedDomains.set(d, (usedDomains.get(d) || 0) + 1);
    return true;
  };
  const authority = dedup.filter((l) => classOf(l.url) === "authority");
  const community = dedup.filter((l) => classOf(l.url) === "community");
  const others = dedup.filter((l) => classOf(l.url) === "other");
  const freshOthers = others.filter((l) => l.fresh);

  // 桶一·权威定事实：2 篇，同域只留 1
  authority.slice(0, 4).forEach((l) => picked.length < 2 && take(l, 1));
  // 桶二·时效进展：1 篇（近30天、非权威、不撞已选域名）
  for (const l of freshOthers) {
    if (picked.length >= 3) break;
    if (take(l, 1)) break;
  }
  // 桶三·圈内讨论：梗类 2 篇；普通话题 1 篇；若权威候选本身就稀少
  //（小众选手/亚文化人物几乎没有媒体报道），保底自动提到 2——配额跟着
  // 真实召回到的源结构走，不硬凑新闻、也不埋没社区。
  const commQuota = folkAsk || authority.length === 0 ? 2 : 1;
  for (const l of community) {
    if (picked.filter((x) => classOf(x.url) === "community").length >= commQuota) break;
    take(l, 1);
  }
  // 回填：按相关度，同域上限 2，直到 5 篇
  for (const l of dedup) {
    if (picked.length >= 5) break;
    take(l, 2);
  }
  // 未入选的按相关度接在后面（下游作为快照兜底，顺序仍有意义）
  const rest = dedup.filter((l) => !picked.includes(l));
  return [...picked, ...rest].map(({ title, url, snippet, source, date }) => ({
    title,
    url,
    snippet,
    source,
    date,
  }));
}

// ───────────────────────── 对外入口 ─────────────────────────

// 给一批参考链接，返回每篇的「全文 or 快照」结果（顺序与去重后输入一致）。
// 全文最多 maxFull 篇（按输入顺序——上游已按相关度排过），其余/失败/封死域退回快照。
export async function fetchDocs(
  links: ArticleLink[],
  maxFull = MAX_FULL
): Promise<FetchedDoc[]> {
  const seen = new Set<string>();
  const uniq: ArticleLink[] = [];
  for (const l of links) {
    if (!l?.url || seen.has(l.url)) continue;
    seen.add(l.url);
    uniq.push(l);
  }
  // 选出允许敲门的前 maxFull 篇；其余直接快照
  const fetchableIdx: number[] = [];
  const docs: FetchedDoc[] = uniq.map((l, i) => {
    const cached = cacheGet(l.url);
    if (cached) return cached;
    if (fetchableIdx.length < maxFull && /^https?:\/\//i.test(l.url) && !isBlocked(l.url)) {
      fetchableIdx.push(i);
    }
    return {
      url: l.url,
      title: l.title,
      source: l.source || hostOf(l.url),
      date: l.date,
      full: false,
      text: (l.snippet || "").trim(),
      cn: cnChars(l.snippet || ""),
    };
  });

  // 并发 6（一批通常≤5），全部静默兜底
  const worker = async (i: number) => {
    try {
      const doc = await fetchOne(uniq[i]);
      docs[i] = doc;
      cacheSet(doc);
    } catch {
      /* 保持快照兜底 */
    }
  };
  const queue = [...fetchableIdx];
  const runners = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const i = queue.shift();
      if (i === undefined) break;
      await worker(i);
    }
  });
  await Promise.all(runners);
  return docs;
}

// 把抓取结果格式化成喂给写稿模型的资料块
export function renderDocsBlock(docs: FetchedDoc[]): string {
  // d.full 由抓取侧的质量门判定（长文≥300中文字、社交帖≥40），这里不再重复阈值，
  // 否则微博短帖会被误标进"原站正文无法抓取"快照段。
  const full = docs.filter((d) => d.full);
  const rest = docs.filter((d) => !d.full && d.cn >= 10);
  const parts: string[] = [];
  if (full.length) {
    parts.push(
      "【原文摘录·服务端刚刚实时抓取】以下是参考文章的正文摘录（含标点，按原顺序排列），" +
        "写稿涉及的具体事实/数字/引语只能出自这里和上面给出的资料，摘录没写的不许补：\n" +
        full
          .map((d, i) => {
            const meta = [d.source, d.date].filter(Boolean).join(" · ");
            return `〔原文${i + 1}〕《${d.title}》${meta ? `（${meta}）` : ""}\n${d.text}`;
          })
          .join("\n\n")
    );
  }
  if (rest.length) {
    parts.push(
      "【搜索快照·原站正文无法抓取，仅有摘要】信息密度低于上面的原文摘录，使用时更要克制：\n" +
        rest
          .map((d) => {
            const meta = [d.source, d.date].filter(Boolean).join(" · ");
            return `· ${d.title}${meta ? `（${meta}）` : ""}：${d.text}`;
          })
          .join("\n")
    );
  }
  return parts.join("\n\n");
}
