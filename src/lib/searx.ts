// 自建 SearXNG 共享客户端：chat/detail/script/domain-meaning 四个路由的检索统一走这里。
//
// 2026-09 加固背景（"能搜到却返回空结果"事故）：上游引擎（baidu/sogou/chinaso）从机房 IP
// 长期触发 CAPTCHA 已基本不可用，突发重复查询时连 bing/google 也会被瞬时限流。此前各路由
// 各自复制了一份检索代码，全部"单次单发、失败/为空即交空、无缓存"，导致：同一检索词一晚
// 被打几十次真实引擎查询（自己触发限流）；偶发赶上限流窗口就直接把空结果交给模型。
// 三层修复：
//   1) 超时统一 12s，显式检查 HTTP 状态；
//   2) 空/异常自动换词重试一次（去掉修饰词只留核心词，扩大命中面）；
//   3) 10 分钟 TTL 结果缓存，吸收重复查询——既保护引擎配额，也顺带提速。

import http from "http";
import https from "https";
import {
  recordSourceHealth,
  type SourceHealthEntry,
} from "./sourceHealth";
import { titleRelevant, isDefinitionQuery, queryPlan } from "./relevance";
import { getLlm } from "./llm";

export interface SearxHit {
  title: string;
  url: string;
  content: string;
  published?: string; // YYYY-MM-DD，来自引擎 publishedDate（部分引擎缺失）
}

const SEARXNG_URL = (process.env.SEARXNG_URL || "").replace(/\/+$/, "");
const SEARXNG_TOKEN = process.env.SEARXNG_TOKEN || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 成人/SEO 内容农场黑名单：标题或摘要命中即丢弃（模糊词检索时最容易被顶上来）
const JUNK_RE =
  /成人|在线观看|无码|高清资源|免费观看|性爱|裸体|色情|情色|番号|做爱|三级片|自慰|一区二区|入口18|漫画网址|完整版在线|免费下载|磁力|种子下载|av在线|18\+/i;
// 标题被符号打码的 m.blog.* 垃圾站特征
const BLOG_MASK_RE = /[✖❌⚠]{1,}/;
const BLOG_URL_RE = /blog\./i;
// 搜索引擎自身页/聚合 topic 页——chat 事实核实时剔除（点进去是另一组搜索结果，不是内容页）。
// 2026-09 修正：百科（baike/wikipedia）不再在此剔除——权威桶已把它们作为概念类问题的
// 最优参考源显式保席，但旧过滤在解析层就删掉百科，保席只能靠 LLM 工具路偶然召回，
// 直接表现为"降准"这类问题的百度百科时有时无（实测引擎对长短词都稳定召回百科前两位）。
const SEARCH_SELF_URL_RE =
  /zhihu\.com\/topic|baidu\.com\/s\?|bing\.com\/search|google\.[a-z.]+\/search/;

export interface SearxOptions {
  limit?: number;
  safesearch?: 0 | 1; // 默认 1
  category?: "general" | "videos" | "news"; // 默认 general
  timeRange?: "" | "day" | "week" | "month" | "year"; // 默认 ""（不限）
  dropWiki?: boolean; // 剔除搜索引擎自身页/topic 聚合页（百科保留，chat 事实核实用 true）
  timeoutMs?: number; // 默认 12000
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 80;
// 缓存与健康日志同样挂 globalThis（原因同 sourceHealth.ts：route bundle 各持模块副本，
// 不挂全局则 /api/health 永远看不到检索记录、缓存也无法跨 route 复用）
const g = globalThis as unknown as {
  __HT_SEARX_CACHE__?: Map<string, { at: number; hits: SearxHit[] }>;
  __HT_SEARX_HEALTH__?: SourceHealthEntry[];
};
const cache = (g.__HT_SEARX_CACHE__ ??= new Map());

// 检索健康度：保留最近 10 次真实引擎调用的结果，写入 SOURCE_HEALTH（key=联网检索），
// /api/health 直接可见——检索源挂没挂、哪句话没查到，不用再 SSH 查 docker logs。
// 缓存命中不记录（没有新的引擎侧信息）；失败不重试成功也留痕（error 里写明原因）。
const SEARX_HEALTH_KEY = "联网检索";
const searxHealthLog = (g.__HT_SEARX_HEALTH__ ??= []);
function recordSearxHealth(source: string, ok: boolean, error: string): void {
  searxHealthLog.unshift({ source, ok, error, at: Date.now() });
  if (searxHealthLog.length > 10) searxHealthLog.pop();
  recordSourceHealth(SEARX_HEALTH_KEY, searxHealthLog);
}

// 换词重试用的简化查询：剥掉会干扰分词的符号，只留前 2-3 个核心词
// （crawler.ts 自建爬虫检索也复用同一套短核心词逻辑，保证各源检索口径一致）
export function varyQuery(q: string): string {
  const clean = q
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。.！!？?~—\-*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const toks = clean.split(" ").filter(Boolean);
  // 只截断长查询（>3 词留 3，>2 词留 2）。2026-09 修雷：此前 2 词查询会掉进
  // toks[0] 分支被砍成 1 词——"zont1x 男模"只剩"zont1x"，爬虫路（detail/script/chat
  // 全经过这里）实际一直在拿纯主体名搜平台，角度词被静默丢弃，角度向内容永远搜不到。
  if (toks.length > 3) return toks.slice(0, 3).join(" ");
  if (toks.length > 2) return toks.slice(0, 2).join(" ");
  return toks.join(" ") || q;
}

// videos 类目专用查询词（2026-09）：bilibili 视频标题口语化、用词短（"帅哥/耍帅/出神颜"），
// 数字梗词（"361度/18岁/六冠"）在视频标题里极少原样出现——只有那条专门玩梗的视频
// （"宗宗360°的帅怎么被截出361°了"）会原样写。若 videos 路带着数字梗词做 AND 搜索，
// 泛颜值向视频（"本质帅哥 zont1x""顶级男模宗主耍帅"）反而被滤光。
// 故 videos 路【去掉数字开头的 token】，保留实体 + 描述性词（"zont1x 颜值"），召回最全；
// searxSearchUnion 会另外用原查询补一路 videos，捞那条原样玩梗的视频，两路并集。
// 规则只认"数字开头 token"，不依赖任何硬编码词表，对任意主题通用。
export function videoQuery(q: string): string {
  const toks = q
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。.！!？?~—\-*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const desc = toks.filter((t) => !/^\d/.test(t));
  // 至少保留实体（首个 token）+ 一个描述词；全是数字或只有实体时退回原词
  if (desc.length >= 2) return desc.join(" ");
  return toks.join(" ") || q;
}

async function fetchWithTimeout(
  url: string,
  options: Record<string, unknown>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// 摘要日期抠取（2026-09）：网页引擎（百度/知乎/贴吧等经它进来）基本不带 publishedDate，
// 但摘要文本里常带绝对日期（"2026年9月8日""2026-09-08"）或相对时间（"3天前""昨天"）。
// 抠出来回填 published，让"新帖优先/新鲜度加权/采信较新说法"对文章侧也生效。
// 无年份「月日」按平台惯例（今年的帖子只显示月-日）补当年，但只认时间戳落位的独立词（见下）。
function dateFromText(text: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const abs = text.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?/);
  if (abs) {
    const t = new Date(+abs[1], +abs[2] - 1, +abs[3]).getTime();
    // 合法窗：2000年起、不晚于明天（时区容差）、不早于400天前（摘要极少展示更早的发布日期，
    // 更早的"日期"多半是正文里讲的历史事件，标上去反而会把新文章误判成旧文）
    if (
      +abs[1] >= 2000 &&
      +abs[1] <= now.getFullYear() &&
      t <= today.getTime() + 864e5 &&
      t >= today.getTime() - 400 * 864e5
    )
      return new Date(t).toISOString().slice(0, 10);
  }
  const relDays = text.match(/(\d+)\s*天前/);
  if (relDays) {
    const n = +relDays[1];
    if (n >= 1 && n <= 365)
      return new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
  }
  if (/(\d+)\s*小时前|[刚刚]{2}|分钟前/.test(text)) return toISO(today);
  if (/昨天/.test(text)) return toISO(new Date(today.getTime() - 864e5));
  // 无年份「月日」（平台惯例：今年的帖子时间戳只显示月-日，跨年才带年）——但摘要里正文
  // 提到的旧事件日期（"在9月8日的比赛"）也长这样，会把旧闻误标成新帖。折中：
  // 只认「独立成词」的月日（前后是标点/空白/括号，典型的时间戳落位），嵌在句中一律不认；
  // 且按"无年份=今年"推算出的日期不得晚于今天（今年还没到 → 它不是时间戳，弃用）。
  // 数字形式（09-08）要求两位零填充——比赛比分（13-8、2-0）几乎不零填充，避免误吞。
  const standalone =
    text.match(
      /(?:^|[。；;！!？?\s（(【\[「])(\d{1,2})月(\d{1,2})[日号](?=$|[。；;！!？?\s）)】\]」」，,．.])/
    ) ||
    text.match(
      /(?:^|[\s。；;（(【\[「])(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?=$|[\s。；;）)】\]」」，,])/
    );
  if (standalone) {
    const d = new Date(now.getFullYear(), +standalone[1] - 1, +standalone[2])
      .getTime();
    if (d <= today.getTime() + 864e5) return new Date(d).toISOString().slice(0, 10);
  }
  return "";
}

function toISO(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function parseResults(json: unknown, o: Required<SearxOptions>): SearxHit[] {
  const results = (json as any)?.results || [];
  const out: SearxHit[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const url: string = r?.url || "";
    const title: string = (r?.title || "").trim();
    const content: string = (r?.content || "").trim();
    if (!title || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    if (JUNK_RE.test(title) || JUNK_RE.test(content)) continue;
    if (BLOG_MASK_RE.test(title) && BLOG_URL_RE.test(url)) continue;
    if (o.dropWiki && SEARCH_SELF_URL_RE.test(url)) continue;
    seen.add(url);
    // publishedDate → YYYY-MM-DD（解析失败留空，不阻塞该条结果）；
    // 引擎没给日期时从标题+摘要抠一次（见 dateFromText）
    const pt = r?.publishedDate ? new Date(r.publishedDate).getTime() : NaN;
    const published = Number.isFinite(pt)
      ? new Date(pt).toISOString().slice(0, 10)
      : dateFromText(`${title} ${content}`);
    out.push({ title, url, content, ...(published ? { published } : {}) });
    if (out.length >= o.limit) break;
  }
  return out;
}

// chinaso 引擎（general/news 两路主力）返回的不是原始新闻页，而是
// https://www.chinaso.com/link?url=<加密> 跳转壳——不解析的后果（2026-09 实测）：
// 参考来源全显示 chinaso.com、权威域名加权失效（gov.cn/新华网都藏在壳后）、用户点开多一跳。
// 壳链接对国内 IP 直接 302 到真实地址，这里在服务端批量解一跳：并发 8、单条 3s、
// 失败保留原壳 URL（绝不因解析失败丢结果）。解析结果随 searx 10min 缓存一并缓存。
// 搜索引擎跳转壳（均为一跳 302 到真实地址，2026-09 实测）：
//  chinaso.com/link —— chinaso / chinaso news 引擎的全部结果
//  baidu.com/link   —— rsshub-baidu（经 RSSHub 绕机房 CAPTCHA 的百度结果，实测能召回
//                      gov.cn 等权威源，不解壳则权威加权全部失效）
const REDIRECT_SHELL_RE =
  /^https?:\/\/(www\.)?(chinaso\.com\/link|baidu\.com\/link)\?/i;
// 用原生 https 拿一跳 302 的 Location——不能用 fetch({redirect:"manual"})，
// 该模式响应是 opaque（status 0、headers 不可读），读不到跳转地址。
function oneHopLocation(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith("https:") ? https : http;
      const req = lib.request(
        url,
        {
          method: "GET",
          headers: { "User-Agent": UA },
          // 不自动跟随：原生模块默认就不跟
        },
        (res) => {
          res.resume(); // 丢弃响应体，避免 socket 挂住
          const loc = res.headers.location || "";
          resolve(/^https?:\/\//.test(loc) ? loc : "");
        }
      );
      req.on("error", () => resolve(""));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve("");
      });
      req.end();
    } catch {
      resolve("");
    }
  });
}
// 全局壳→真实URL缓存（30min）：五路事实预取 × union 四路会产生 20+ 壳/轮，
// 且同一目标在不同查询词下壳的 url= 参数相同（只有 wd/pos 变化）。跨查询共享后
// 稳态下每轮真正需要请求壳站的只有几条新壳，从根上避开 chinaso 突发限流。
const shellCacheG = globalThis as unknown as {
  __HT_SHELL_CACHE__?: Map<string, { at: number; real: string }>;
};
const shellCache = (shellCacheG.__HT_SHELL_CACHE__ ??= new Map());
const SHELL_CACHE_TTL = 30 * 60 * 1000;
function shellCacheKey(shell: string): string {
  try {
    const u = new URL(shell);
    return u.searchParams.get("url") || shell;
  } catch {
    return shell;
  }
}
async function resolveChinasoLinks(hits: SearxHit[]): Promise<{
  out: SearxHit[];
  resolved: number;
  pending: number;
}> {
  const targets = hits.filter((h) => REDIRECT_SHELL_RE.test(h.url));
  if (!targets.length) return { out: hits, resolved: 0, pending: 0 };
  // 先吃全局缓存（同一 url= 参数只解一次）
  const map = new Map<string, string>();
  const fresh: string[] = [];
  const now = Date.now();
  for (const h of targets) {
    const c = shellCache.get(shellCacheKey(h.url));
    if (c && now - c.at < SHELL_CACHE_TTL) map.set(h.url, c.real);
    else if (!fresh.includes(h.url)) fresh.push(h.url);
  }
  let cursor = 0;
  // 并发池 6（比旧版 10 更温和，2026-09 实测突发 20+ 并发会被 chinaso 限流拖慢）；
  // 单条失败（限流多为瞬时 RST/429）400ms 后重试一次——解壳成功率直接决定权威域名
  // 识别与保席能否生效，未解的壳只能显示 chinaso.com 且权威加权完全失效。
  const workers = Array.from({ length: Math.min(6, fresh.length) }, async () => {
    while (cursor < fresh.length) {
      const shell = fresh[cursor++];
      let real = await oneHopLocation(shell, 2500);
      if (!real) {
        await new Promise((r) => setTimeout(r, 400));
        real = await oneHopLocation(shell, 2500);
      }
      const final = real || shell;
      map.set(shell, final);
      if (real) shellCache.set(shellCacheKey(shell), { at: Date.now(), real });
    }
  });
  // 总预算硬上限 8s（searx 单路 timeout 12s 内）：壳站挂起时宁可保留原壳也不拖垮整路。
  const done = Promise.all(workers);
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
  // 预算耗尽仍未解析的壳：后台续解（不阻塞本轮响应），只写全局缓存——
  // 冷启动突发并发（多用例评测）首轮必有限流，续解让第二轮起全部热缓存命中。
  if (cursor < fresh.length) {
    fresh
      .slice(cursor)
      .forEach((shell) =>
        oneHopLocation(shell, 2500)
          .then((real) => {
            if (real)
              shellCache.set(shellCacheKey(shell), { at: Date.now(), real });
          })
          .catch(() => {})
      );
  }
  let pending = 0;
  const seen = new Set<string>(hits.map((h) => h.url));
  const out: SearxHit[] = [];
  for (const h of hits) {
    if (!REDIRECT_SHELL_RE.test(h.url)) {
      out.push(h); // 非壳条目原样保留，不计入解壳统计
      continue;
    }
    const real = map.get(h.url);
    if (!real) {
      pending++;
      out.push(h);
      continue;
    }
    if (real === h.url || seen.has(real)) {
      if (real !== h.url) continue; // 真实 URL 与其他条目重复，丢弃壳
      pending++; // 解壳失败保留原壳
      out.push(h);
      continue;
    }
    seen.add(real);
    out.push({ ...h, url: real });
  }
  return { out, resolved: targets.length - pending, pending };
}
// 缓存命中后回头重解壳（2026-09 补断）：首轮冷缓存突发限流时，部分壳会以原壳 URL 被一起
// 写进 10min 结果缓存，而后台续解只写 shellCache、改不了已经缓存的快照——旧实现命中缓存
// 直接返回，"第二轮热缓存命中"实际上永远不发生。这里在命中缓存时检查快照里是否仍有壳：
// 有则用（可能已被后台续解填热的）shellCache 重解一次并回写，真正完成自愈；无壳快照零开销。
async function reResolveCached(
  key: string,
  cached: { at: number; hits: SearxHit[] }
): Promise<SearxHit[]> {
  if (!cached.hits.some((h) => REDIRECT_SHELL_RE.test(h.url))) return cached.hits;
  const { out, resolved, pending } = await resolveChinasoLinks(cached.hits);
  if (pending === 0 || resolved > 0) cache.set(key, { at: cached.at, hits: out });
  return out;
}

async function searxFetchOnce(
  q: string,
  o: Required<SearxOptions>
): Promise<SearxHit[]> {
  const tr = o.timeRange ? `&time_range=${o.timeRange}` : "";
  const u =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}` +
    `&format=json&language=zh-CN&safesearch=${o.safesearch}${tr}&categories=${o.category}`;
  const res = await fetchWithTimeout(
    u,
    {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        // 反代校验用的共享密钥，防止 SearXNG 被当成公开代理滥用
        ...(SEARXNG_TOKEN ? { "X-Detail-Token": SEARXNG_TOKEN } : {}),
      },
    },
    o.timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseResults(await res.json(), o);
  const nShell = parsed.filter((h) => REDIRECT_SHELL_RE.test(h.url)).length;
  try {
    const { out, resolved, pending } = await resolveChinasoLinks(parsed);
    if (nShell)
      console.warn(
        `[searx-shell] cat=${o.category} q=${q.slice(0, 20)} parsed=${parsed.length} shell=${nShell} ok=${resolved} pending=${pending} -> out=${out.length}`
      );
    return out;
  } catch (e) {
    console.warn(
      `[searx-shell] RESOLVE THROW cat=${o.category}: ${(e as Error)?.stack || e}`
    );
    throw e;
  }
}

// —— 商业搜索 API 兜底（2026-09 数据源加固）——
// 触发条件（两个都满足才花钱）：
//   1. 单路 searxSearch：SearXNG 免费源两次皆空；searxSearchUnion：网页桶 < LOW_RECALL_WEB 条
//      （含 SearXNG 整站挂掉网页 0 条、以及网页引擎半死只剩 bilibili 视频的情况）；
//   2. 当前是【系统内部调用】（scheduler 定时抓取，getLlm().systemOwned）。
// 公开访客的请求即使全空也不走这里——站点无口令，不能让访客刷机主付费额度。
// 顺序按用户要求"免费优先、没有再付费"：
//   档1 Tavily：每月 1000 credits 永久免费、无需信用卡，basic 搜索 1 credit/次，
//               超额 $0.008/次（2026-09 官网价）；机房实测 api.tavily.com 0.68s 可达。
//   档2 博查 Bocha：国内中文搜索、为 AI 优化，web-search 按量约 ¥0.03/次
//               （资源包更低，2026-09 阿里云市场 AI 搜 ¥0.06/次佐证量级）；
//               机房实测 api.bochaai.com 0.17s 可达。
// 任一档没配 key 自动跳过；HTTP/解析失败 fail-open 返空，绝不阻塞主流程。
// 返回结果同样进 10 分钟结果缓存，重复词不会重复花钱。
//
// 低召回阈值（2026-09 用户反馈"全是微博/视频也不对"后新增）：union 主检索的
// 触发条件不是"总结果 0 条"，而是【网页桶 < 3 条】——bilibili 是独立引擎，网页引擎
// 集体限流时它仍可能返回十几条视频，看总数会漏判。补位是【并入】不是替换，
// 且最多并入 LOW_RECALL_WEB_FILL 条，防止商业结果反客为主。
// 单路 searxSearch 仍维持"0 条才兜"：救援切词会扇出多个查询，<3 即花钱会烧穿额度。
const LOW_RECALL_WEB = 3;
const LOW_RECALL_WEB_FILL = 6;
function commercialAllowed(): boolean {
  try {
    return getLlm().systemOwned === true;
  } catch {
    return false;
  }
}

async function tavilySearch(
  q: string,
  o: Required<SearxOptions>
): Promise<SearxHit[]> {
  const apiKey = (process.env.TAVILY_API_KEY || "").trim();
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: q,
        max_results: Math.min(o.limit, 10),
        search_depth: "basic",
        topic: "general",
        // 免费、不额外扣 credit：不传时 published_date 恒为空，救回条目进不了新鲜桶（2026-09 实测 0/3→2/3 带日期）
        include_published_date: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
    const data = await res.json();
    const raw = Array.isArray((data as any)?.results)
      ? (data as any).results.map((r: any) => ({
          title: r?.title || "",
          url: r?.url || "",
          content: r?.content || r?.raw_content || "",
          ...(r?.published_date ? { publishedDate: r.published_date } : {}),
        }))
      : [];
    return parseResults({ results: raw }, o);
  } finally {
    clearTimeout(id);
  }
}

async function bochaSearch(
  q: string,
  o: Required<SearxOptions>
): Promise<SearxHit[]> {
  const apiKey = (process.env.BOCHA_API_KEY || "").trim();
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const res = await fetch("https://api.bochaai.com/v1/web-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: q,
        count: Math.min(o.limit, 10),
        summary: true,
        freshness: "noLimit",
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`bocha HTTP ${res.status}`);
    const data = await res.json();
    // 博查返回结构 data.webPages.value[]；字段名多版本不一致，宽容解析。
    const value = (data as any)?.data?.webPages?.value;
    const raw = Array.isArray(value)
      ? value.map((r: any) => ({
          title: r?.name || r?.title || "",
          url: r?.url || r?.link || "",
          content: r?.summary || r?.snippet || r?.description || "",
          ...(r?.datePublished || r?.publish_time || r?.dateLastCrawled
            ? {
                publishedDate:
                  r?.datePublished || r?.publish_time || r?.dateLastCrawled,
              }
            : {}),
        }))
      : [];
    return parseResults({ results: raw }, o);
  } finally {
    clearTimeout(id);
  }
}

// 免费档 → 付费档顺序尝试，任一档有结果即返回；全空/未配置返回 []。
async function commercialFallback(
  q: string,
  o: Required<SearxOptions>
): Promise<{ hits: SearxHit[]; via: string }> {
  if (!commercialAllowed() || !q) return { hits: [], via: "" };
  if ((process.env.TAVILY_API_KEY || "").trim()) {
    try {
      const hits = await tavilySearch(q, o);
      if (hits.length > 0) return { hits, via: "tavily" };
    } catch (e) {
      console.warn(
        `[search-fallback] tavily 失败 q=${q.slice(0, 20)}: ${
          (e as Error)?.message || e
        }`
      );
    }
  }
  if ((process.env.BOCHA_API_KEY || "").trim()) {
    try {
      const hits = await bochaSearch(q, o);
      if (hits.length > 0) return { hits, via: "bocha" };
    } catch (e) {
      console.warn(
        `[search-fallback] bocha 失败 q=${q.slice(0, 20)}: ${
          (e as Error)?.message || e
        }`
      );
    }
  }
  return { hits: [], via: "" };
}

export async function searxSearch(
  query: string,
  opts: SearxOptions = {}
): Promise<SearxHit[]> {
  const q = (query || "").trim();
  const o: Required<SearxOptions> = {
    limit: 12,
    safesearch: 1,
    category: "general",
    timeRange: "",
    dropWiki: false,
    timeoutMs: 12000,
    ...opts,
  };
  if (!SEARXNG_URL || !q) return [];

  const key = JSON.stringify([q, o.limit, o.safesearch, o.category, o.timeRange, o.dropWiki]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS)
    return reResolveCached(key, cached);

  // 第 1 发：原词
  const tag = `searx:${q.slice(0, 24)}`;
  let hits: SearxHit[] = [];
  let firstErr = "";
  try {
    hits = await searxFetchOnce(q, o);
  } catch (e) {
    firstErr = (e as Error)?.message || String(e);
    console.warn(`[searx] 首发失败 q=${q}: ${firstErr}`);
  }
  // 第 2 发：空/异常时换简化词重试（引擎限流窗口通常很短，且简化词命中面更大）
  if (hits.length === 0) {
    const q2 = varyQuery(q);
    let secondErr = "";
    try {
      hits = await searxFetchOnce(q2, o);
      if (hits.length > 0) {
        console.warn(`[searx] 换词重试成功 q="${q}" -> "${q2}"，${hits.length} 条`);
        recordSearxHealth(
          tag,
          true,
          `首发${firstErr ? `异常(${firstErr})` : "0条"}，换词"${q2}"重试成功`
        );
      }
    } catch (e) {
      secondErr = (e as Error)?.message || String(e);
      console.warn(`[searx] 换词重试仍失败 q2=${q2}: ${secondErr}`);
    }
    if (hits.length === 0) {
      // 免费源两路皆空：仅系统内部调用时用商业 API（Tavily 免费档→博查）兜一次
      const fb = await commercialFallback(q2, o);
      if (fb.hits.length > 0) {
        hits = fb.hits;
        recordSearxHealth(
          tag,
          true,
          `免费源全空（首发${firstErr ? `异常(${firstErr})` : "0条"}；换词"${q2}"${
            secondErr ? `异常(${secondErr})` : "仍0条"
          }），商业兜底[${fb.via}]救回 ${hits.length} 条`
        );
      } else {
        recordSearxHealth(
          tag,
          false,
          `首发${firstErr ? `异常(${firstErr})` : "0条"}；换词"${q2}"重试${
            secondErr ? `异常(${secondErr})` : "仍0条"
          }${commercialAllowed() ? "" : "（访客请求不用商业兜底）"}`
        );
      }
    }
  } else {
    recordSearxHealth(tag, true, "");
  }

  if (hits.length > 0) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), hits });
  }
  // 失败不缓存：避免把限流窗口的空结果钉死 10 分钟
  return hits;
}

// —— 四路并集检索（方案A，2026-09）：根治"近一个月帖子召回不足 / 搜索词过长" ——
//   路1 短核心词不限时（general）：身份/归属/属性类权威资料；
//   路2 短核心词近30天（general）：新帖（用户主诉"最近一个月的帖子搜不到"）；
//   路3 短核心词视频类目（videos→bilibili）：赛事/事件第一手动态，标题时效性强；
//   路4 短核心词新闻类目（news→chinaso news）：机构媒体报道，自带发布日期。
// 四路并发（总耗时≈单路 12s 上限），按 URL 去重后排序：
// 近一年内带日期的按新→旧排最前，其余（更旧/无日期）保持合并序在后。
export async function searxSearchUnion(
  query: string,
  opts: SearxOptions = {}
): Promise<SearxHit[]> {
  const q = (query || "").trim();
  const o: Required<SearxOptions> = {
    limit: 12,
    safesearch: 1,
    category: "general",
    timeRange: "",
    dropWiki: false,
    timeoutMs: 12000,
    ...opts,
  };
  if (!SEARXNG_URL || !q) return [];

  // 统一拆解（所有调用方、所有题型）：先剥疑问句式得到检索短语，再截短核心词。
  // 中文整句无空格，varyQuery 对整句完全无效——不剥壳，平台/引擎两边都零召回。
  const plan = queryPlan(q);
  const core = varyQuery(plan.main);
  // 题型判定仍看【原始问句】："什么是降准"剥壳后只剩"降准"，用剥壳结果判型
  // 会让定义类权威补轮永远不触发。
  const isDef = isDefinitionQuery(q);
  // 裸主体词（去语境词）："什么是降准"→"降准"，定义补轮用它召回权威；
  // 百科相关性门控则用带语境的 gateSubject——否则"芯片"百科会被误当 cs 梗的权威。
  const subject = plan.bare;
  const gateSubject = plan.main;
  // videos 路泛化词：去掉数字梗 token（见 videoQuery）
  const vWide = videoQuery(plan.main);
  const key = JSON.stringify(["union", core, vWide, o.limit, o.safesearch, o.dropWiki]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS)
    return reResolveCached(key, cached);

  // 每路抓取深度高于最终出槽数（2026-09 实测）：chinaso 结果里跳转壳/百度自身页与真实
  // 内容交错排列，gov.cn/news.cn 等权威源常在原始序列第 16-22 位，按最终 limit(10/12)
  // 在解析层提前截断会让它们根本进不了分桶。非内容页会被过滤跳过，深取不增加垃圾；
  // 多解的壳由全局壳缓存+并发池+后台续解兜底。最终出槽仍由 o.limit 封顶。
  const fo: Required<SearxOptions> = { ...o, limit: 16 };
  // news 类目请求只发一次：路2（近30天）与路4（新闻）在首轮复用同一个 Promise（备忘录），
  // 避免双倍打 chinaso 配额；空结果重试时重置备忘录发新请求（限流后老 Promise 已定格为空）。
  let newsShared: Promise<SearxHit[]> | null = null;
  const newsP = () =>
    (newsShared ??= searxFetchOnce(core, { ...fo, timeRange: "", category: "news" }));
  const routes: {
    label: string;
    fetch: () => Promise<SearxHit[]>;
  }[] = [
    {
      label: "不限时",
      fetch: () => searxFetchOnce(core, { ...fo, timeRange: "", category: "general" }),
    },
    {
      label: "近30天",
      // 2026-09 实测：bing 根本不支持 time_range（月内 general 只剩 chinaso 一个源，经常 0 条），
      // 所以这路改为 general 月内 ∪ news 并集——新闻类目天然新鲜且 chinaso news 全带发布日期，
      // 等于给"近30天"接上一个稳源。与第4路（news 不限时）重复的条目由下方 seen 去重。
      fetch: () =>
        Promise.all([
          searxFetchOnce(core, { ...fo, timeRange: "month", category: "general" }),
          newsP(),
        ]).then(([a, b]) => {
          const seen = new Set<string>();
          return [...a, ...b].filter((h) =>
            seen.has(h.url) ? false : (seen.add(h.url), true)
          );
        }),
    },
    {
      label: "视频",
      // 双路并集：① 泛化词 vWide（去数字梗，"zont1x 颜值"）召回口语化颜值/耍帅向视频；
      // ② 原词 core（"zont1x 361度"）补捞原样玩梗视频（"360°帅被截361°"）。
      // 单路用 core 会因数字梗 AND 过严把泛颜值视频滤光（2026-09 实测）。
      fetch: () =>
        Promise.all([
          searxFetchOnce(vWide, { ...fo, timeRange: "", category: "videos" }),
          searxFetchOnce(core, { ...fo, timeRange: "", category: "videos" }),
        ]).then(([a, b]) => {
          const seen = new Set<string>();
          return [...a, ...b].filter((h) =>
            seen.has(h.url) ? false : (seen.add(h.url), true)
          );
        }),
    },
    {
      label: "新闻",
      fetch: newsP,
    },
  ];
  const settled = await Promise.allSettled(routes.map((r) => r.fetch()));

  // 空结果补一轮重试（2026-09 评测实证）：bilibili/chinaso 等引擎在突发并发下会短暂限流，
  // 表现为 HTTP 200 但结果数组为空（健康日志实测：连续评测期间"视频0条/新闻0条"，几分钟后
  // 同查询恢复 20 条）。单路 searxSearch 原本就有"空结果换词重试"，union 没有。这里对
  // 【fulfilled 但 0 条】的路由统一延迟 1.2s 后原请求重试一次（失败的路由不重试，错误非限流）。
  const emptyIdx = settled
    .map((s, i) => (s.status === "fulfilled" && s.value.length === 0 ? i : -1))
    .filter((i) => i >= 0);
  if (emptyIdx.length > 0) {
    // 涉及 news 的路（1=近30天内含news，3=新闻）重试前重置备忘录，强制发新请求。
    if (emptyIdx.includes(1) || emptyIdx.includes(3)) newsShared = null;
    await new Promise((r) => setTimeout(r, 1200));
    const retried = await Promise.allSettled(emptyIdx.map((i) => routes[i].fetch()));
    retried.forEach((s, k) => {
      if (s.status === "fulfilled" && s.value.length > 0) {
        settled[emptyIdx[k]] = { status: "fulfilled", value: s.value };
      }
    });
  }

  const seen = new Set<string>();
  // 六桶：网页先抽权威/参考源（不受日期压制），其余网页按"近一年带日期"分新旧；
  // 视频单独两桶受配额限制。
  // 2026-09 数据源评测两层实锤：
  //  ①旧逻辑所有路混在一起纯按日期 slice(limit)，bilibili 视频永远当天最新，整批
  //    挤在最前把网页截断（视频配额 ≤45% 治此）；
  //  ②仅修①后，近30天路返回的蹭词新闻（带近期日期）又把无日期的百度百科/央行定义/
  //    政府老政策文全部挤出——"什么是降准"这类概念问题最该给的恰恰是后者。故权威/
  //    参考源独立成桶、最高优先且封顶 6 条。
  const AUTHORITY_HOST_RE_UNION =
    /(^|\.)(gov\.cn|news\.cn|xinhuanet\.com|people\.com\.cn|people\.cn|cctv\.cn|cnr\.cn|gmw\.cn|chinanews\.com|thepaper\.cn|caixin\.com|cls\.cn|wallstreetcn\.com|yicai\.com|stcn\.com|guancha\.cn|pbc\.gov\.cn|baike\.baidu\.com|wikipedia\.org|baike\.so\.com)$/i;
  // 百科只是权威【候选】：单字/词义页（"降"/"董"/"广州市"）也挂 baike 域名，
  // 必须过裸主体词相关性门控才能进权威桶，不相关则降为普通网页兜底。
  const ENCYCLOPEDIA_HOST_RE_UNION =
    /(^|\.)(baike\.baidu\.com|wikipedia\.org|baike\.so\.com)$/i;
  // 词典/字典/翻译站：对任何热点问题都是噪声（"董"的拼音页、city 翻译页）。
  // 一律沉 webRest——哪怕带日期也不许借新鲜度插队，但不删除（结果不足时仍兜底）。
  const DICT_SITE_HOST_RE =
    /(^|\.)(hgcha\.com|hanyuguoxue\.com|iciba\.com|wiktionary\.org|dictionary\.cambridge\.org|collinsdictionary\.com|britannica\.com|zdic\.net|chazidian\.com|shidianguji\.com|chagushici\.com|dict\.cn|dict\.youdao\.com|zidian\.[a-z.]+)$/i;
  const authorityWeb: SearxHit[] = [];
  const webFresh: SearxHit[] = [];
  const webRest: SearxHit[] = [];
  const vFresh: SearxHit[] = [];
  const vRest: SearxHit[] = [];
  const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  };
  const stats: string[] = [];
  // 单条网页结果分桶（首轮与定义补轮共用同一套规则）
  const bucketOne = (h: SearxHit) => {
    const host = hostOf(h.url);
    const isNew =
      !!h.published && new Date(h.published).getTime() >= yearAgo;
    if (AUTHORITY_HOST_RE_UNION.test(host)) {
      if (
        !ENCYCLOPEDIA_HOST_RE_UNION.test(host) ||
        titleRelevant(h.title, gateSubject, plan.context)
      ) {
        authorityWeb.push(h);
      } else {
        // 不相关百科（单字/词义页）不丢弃，降普通网页兜底
        (isNew ? webFresh : webRest).push(h);
      }
    } else if (DICT_SITE_HOST_RE.test(host)) {
      webRest.push(h);
    } else {
      (isNew ? webFresh : webRest).push(h);
    }
  };
  settled.forEach((s, i) => {
    const label = routes[i].label;
    const isVideo = i === 2; // routes[2]=视频（bilibili 双路）
    if (s.status === "fulfilled") {
      let n = 0;
      for (const h of s.value) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        n++;
        if (isVideo) {
          const isNew =
            !!h.published && new Date(h.published).getTime() >= yearAgo;
          (isNew ? vFresh : vRest).push(h);
        } else {
          bucketOne(h);
        }
      }
      stats.push(`${label}${n}条`);
    } else {
      const why = (s.reason as Error)?.message || String(s.reason);
      stats.push(`${label}失败(${why})`);
      console.warn(`[searx-union] 路[${label}] reject q=${core}: ${why}`);
    }
  });
  // 定义类问题的权威缺席补轮（2026-09 实测）：chinaso 逐轮抖动，同查询有时整页没有
  // 百科/gov（HTTP 200 有结果、非限流，空结果重试不触发）。概念/政策问题没有权威源
  // 等于白检——但【只对定义类问题】补：问梗/问名场面/问怎么火时虎扑微博才是对口答案，
  // 一律不补、不加 1.2s。补轮用【裸主体词】（"降准"而非"什么是降准"）：实测整句会被
  // 引擎当"查字典"，整页返回拼音/翻译站，裸词对权威源的召回明显更好。补轮结果随 union
  // 快照缓存，只有冷缓存且零权威时才付这一次代价。
  if (isDef && authorityWeb.length === 0) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const extra = await searxFetchOnce(subject, {
        ...fo,
        timeRange: "",
        category: "general",
      });
      let added = 0;
      const nAuthBefore = authorityWeb.length;
      for (const h of extra) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        added++;
        bucketOne(h);
      }
      const nAuth = authorityWeb.length - nAuthBefore;
      stats.push(`定义补轮${added}条(权威${nAuth})`);
      if (nAuth === 0)
        console.warn(`[searx-union] 定义补轮仍0权威 q=${q} subj=${subject}`);
    } catch {
      stats.push("定义补轮失败");
    }
  }
  // 低召回商业补位（在定义补轮之后，给免费源最后的免费机会；结果随 union 快照缓存）：
  // 网页桶（权威+新+旧）合计 <3 条 = SearXNG 整站挂掉或网页引擎集体半死。此时若不补，
  // detail 层合入的微博/快讯/B站视频会占满结果，缺定事实的网页。商业结果去重后按同一
  // 套 bucketOne 归桶（权威站照样进权威桶），是补位不是替换；最多并入 6 条。
  const webCount = () =>
    authorityWeb.length + webFresh.length + webRest.length;
  if (webCount() < LOW_RECALL_WEB) {
    const webBefore = webCount();
    const fb = await commercialFallback(core, o);
    if (fb.hits.length > 0) {
      let added = 0;
      for (const h of fb.hits) {
        if (added >= LOW_RECALL_WEB_FILL) break;
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        bucketOne(h);
        added++;
      }
      stats.push(`低召回补位[${fb.via}]${added}条(网页原仅${webBefore}条)`);
    }
  }

  for (const arr of [webFresh, vFresh])
    arr.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  // 组装：权威/参考网页(≤6) → 新网页 → 旧网页 → 视频(≤45% 配额)；网页不足时余额让给视频。
  const vQuota = Math.max(2, Math.floor(o.limit * 0.45));
  const hits: SearxHit[] = [];
  let vUsed = 0;
  const push = (arr: SearxHit[], kind: "auth" | "web" | "video") => {
    for (const h of arr) {
      if (hits.length >= o.limit) return;
      if (kind === "auth" && hits.length >= 6) return;
      if (kind === "video" && vUsed >= vQuota) return;
      hits.push(h);
      if (kind === "video") vUsed++;
    }
  };
  push(authorityWeb, "auth");
  push(webFresh, "web");
  push(webRest, "web");
  push(vFresh, "video");
  push(vRest, "video");

  // 商业补位已在组装前按"网页桶 <3 条"触发并归桶，此处不再重复调用。

  if (hits.length > 0) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), hits });
  }
  recordSearxHealth(
    `union:${core.slice(0, 20)}`,
    hits.length > 0,
    hits.length > 0 ? stats.join(" / ") : `四路皆空或失败：${stats.join(" / ")}`
  );
  return hits;
}
