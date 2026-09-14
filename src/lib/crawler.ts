// ht-crawler 共享客户端：自建爬虫（微博/贴吧/知乎）检索，chat 实体资料预取与近30天兜底的
// 补充数据源。服务跑在同一台 VPS（127.0.0.1:6689，仅本机监听；hot-web 容器为
// --network host，localhost 直达，与 dailyhot:6688 / SearXNG:8088 同模式）。
//
// 设计原则（2026-09 方案C接入）：爬虫是"增强源"而非主链路——服务挂了/超时/返回空
// 都必须静默降级为空数组，绝不阻塞或影响 searx 主检索；每个平台的成功/失败明细分开
// 记录到 SOURCE_HEALTH（key=自建爬虫），/api/health 可见。

import { recordSourceHealth, type SourceHealthEntry } from "./sourceHealth";
import { varyQuery } from "./searx";
import { queryPlan, titleRelevant } from "./relevance";

export interface CrawlerHit {
  title: string;
  url: string;
  source: string; // "微博" / "贴吧·吧名" / "知乎"
  content: string;
  published?: string; // YYYY-MM-DD（微博/知乎/贴吧均有；贴吧 2026-09 起由服务端透传）
}

const CRAWLER_URL = (
  process.env.HT_CRAWLER_URL || "http://localhost:6689"
).replace(/\/+$/, "");

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 80;
// 挂 globalThis（原因同 searx.ts：route bundle 各持模块副本，不挂全局则
// /api/health 看不到记录、缓存无法跨 route 复用）
const g = globalThis as unknown as {
  __HT_CRAWLER_CACHE__?: Map<string, { at: number; hits: CrawlerHit[] }>;
  __HT_CRAWLER_HEALTH__?: SourceHealthEntry[];
};
const cache = (g.__HT_CRAWLER_CACHE__ ??= new Map());
const healthLog = (g.__HT_CRAWLER_HEALTH__ ??= []);
const CRAWLER_HEALTH_KEY = "自建爬虫";

function recordCrawlerHealth(source: string, ok: boolean, error: string): void {
  healthLog.unshift({ source, ok, error, at: Date.now() });
  if (healthLog.length > 10) healthLog.pop();
  recordSourceHealth(CRAWLER_HEALTH_KEY, healthLog);
}

// 微博时间 "Tue Sep 08 01:20:38 +0800 2026" → YYYY-MM-DD（北京时间直接取日期，
// 与站点用户时区一致，无需换算）；解析失败返回 ""
const WEIBO_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};
function parseWeiboDate(s: string): string {
  const m = /^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\s+(\d{4})$/.exec(
    String(s || "").trim()
  );
  const mon = m ? WEIBO_MONTHS[m[2]] : undefined;
  if (!m || !mon) return "";
  return `${m[4]}-${String(mon).padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

async function fetchPlatform(
  kind: "weibo" | "tieba" | "zhihu",
  kw: string,
  limit: number,
  timeoutMs: number
): Promise<CrawlerHit[]> {
  const u = `${CRAWLER_URL}/${kind}?kw=${encodeURIComponent(kw)}&limit=${limit}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as any;
    if (!j?.ok) throw new Error(String(j?.err || j?.error || "返回ok=false"));
    const out: CrawlerHit[] = [];
    const seen = new Set<string>();
    for (const it of (j.items || []) as any[]) {
      const url = String(it?.url || "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (kind === "weibo") {
        const user = String(it?.user || "").trim();
        const text = String(it?.text || "").trim();
        if (!text) continue;
        const published = parseWeiboDate(String(it?.time || ""));
        out.push({
          title: `${user ? `${user}：` : ""}${text}`.slice(0, 110),
          url,
          source: "微博",
          content: text.slice(0, 150),
          ...(published ? { published } : {}),
        });
      } else if (kind === "zhihu") {
        // 知乎 search_v3：answer/article/question 卡，标题带 <em> 高亮已由服务端剥掉
        const title = String(it?.title || "").trim();
        if (!title) continue;
        const published = String(it?.published || "").trim();
        out.push({
          title: title.slice(0, 110),
          url,
          source: "知乎",
          content: String(it?.abstract || "").slice(0, 150),
          ...(published ? { published } : {}),
        });
      } else {
        const title = String(it?.title || "").trim();
        if (!title) continue;
        const forum = String(it?.forum || "").trim();
        // 贴吧服务端（ht_crawler._tieba_items）三种返回结构都带 published
        // （YYYY-MM-DD），此前客户端漏读导致参考列表里贴吧帖全无时间戳。
        const published = String(it?.published || "").trim();
        out.push({
          title,
          url,
          source: forum ? `贴吧·${forum}` : "贴吧",
          content: String(it?.abstract || "").slice(0, 150),
          ...(published ? { published } : {}),
        });
      }
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    clearTimeout(id);
  }
}

// ---- 直连 HTML 平台（2026-09 数据源扩充：虎扑/豆瓣）----
// 不走 6689 的 Python 爬虫：这两站搜索是服务端渲染静态页、无登录门槛（2026-09 实测
// 机房 IP 直连 200），hot-web 容器 --network host 可直达公网，直接抓 HTML 正则解析即可。
const HTML_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
}
async function fetchHtmlText(
  url: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": HTML_UA, Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}
// 虎扑帖子搜索（bbs.hupu.com/search）：按 <div class="content-wrap"> 切块，
// 块内依次是 帖子a(hupu.com/长数字.html)+专区a(短数字无.html)+<span>YYYY-MM-DD</span>。
// 标题含 <font color> 高亮标签，解析时剥掉。反爬升级/改版时静默返回空（健康日志可见）。
async function fetchHupu(
  kw: string,
  limit: number,
  timeoutMs: number
): Promise<CrawlerHit[]> {
  const url = `https://bbs.hupu.com/search?q=${encodeURIComponent(kw)}`;
  const html = await fetchHtmlText(url, timeoutMs);
  const out: CrawlerHit[] = [];
  const seen = new Set<string>();
  for (const block of html.split('<div class="content-wrap">').slice(1)) {
    const mPost =
      /href="(https:\/\/bbs\.hupu\.com\/\d{6,}\.html)"[^>]*>([\s\S]*?)<\/a>/.exec(
        block
      );
    if (!mPost) continue;
    if (seen.has(mPost[1])) continue;
    seen.add(mPost[1]);
    const title = unescapeHtml(mPost[2]);
    if (!title) continue;
    const mDate = /<span>(\d{4}-\d{2}-\d{2})<\/span>/.exec(block);
    out.push({
      title: title.slice(0, 110),
      url: mPost[1],
      source: "虎扑",
      content: "",
      ...(mDate ? { published: mDate[1] } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}
// 豆瓣小组讨论搜索（www.douban.com/group/search?cat=1013）：全站搜索需登录，
// 但小组讨论搜索 SSR 直出（实测每页约 49 条）；锚点 td-subject a 的 title 属性即完整标题。
// 时间列是相对日期（"09-11"/"2025-xx"）口径不一，不抠日期（进无日期桶，靠配额约束）。
async function fetchDouban(
  kw: string,
  limit: number,
  timeoutMs: number
): Promise<CrawlerHit[]> {
  const url = `https://www.douban.com/group/search?cat=1013&q=${encodeURIComponent(
    kw
  )}`;
  const html = await fetchHtmlText(url, timeoutMs);
  if (/sec\.douban\.com|异地访问|异常访问/.test(html))
    throw new Error("触发豆瓣安全验证");
  const out: CrawlerHit[] = [];
  const seen = new Set<string>();
  const re =
    /href="(https:\/\/www\.douban\.com\/group\/topic\/\d+)\/[^"]*"[^>]*title="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = unescapeHtml(m[2]);
    if (!title) continue;
    out.push({
      title: title.slice(0, 110),
      url: `${m[1]}/`,
      source: "豆瓣",
      content: "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface CrawlerOptions {
  limit?: number; // 每平台上限（合并后可能略多，调用方自行截断），默认 6
  timeoutMs?: number; // 默认 5000——增强源不许可拖慢主链路
}

// 社区站内搜索对中英混合/多义短词严重串味（2026-09 实测）：
//  "city不city" 在虎扑召回大批曼城(Man City)帖；"降准"召回"降泽警察/一息四至"。
// 零 LLM 词面门控：标题必须命中查询的实义中文 2-gram，或"查询内中字+英文词"的
// 紧邻混合拼接（不city / city不）；纯英文查询要求整词命中；单字/无特征查询不门控。
// titleRelevant / 题型判定 / 主体词剥离统一放 ./relevance（searx/chat/crawler 三处同口径，
// 放在 crawler 会让 searx 与 crawler 循环 import；注释保留见 relevance.ts）。

// 微博+贴吧+知乎（6689 爬虫）+虎扑+豆瓣（直连 HTML）并行检索，URL 去重合并。
// 任何平台失败只记健康日志，不抛错。
export async function crawlerSearch(
  query: string,
  opts: CrawlerOptions = {}
): Promise<CrawlerHit[]> {
  const raw = (query || "").trim();
  if (!raw) return [];
  const limit = opts.limit ?? 6;
  const timeoutMs = opts.timeoutMs ?? 5000;
  // 统一拆解：先剥疑问句式（"cs中的研发芯片是什么梗"→"cs 研发芯片"）再截短核心词，
  // 与 searx 同一套口径；中文整句无空格时 varyQuery 对它完全无效，不剥壳平台搜索零召回。
  const plan = queryPlan(raw);
  const core = varyQuery(plan.main);
  if (!core) return [];

  const key = JSON.stringify(["crawler", core, limit]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hits;

  const labels = ["微博", "贴吧", "知乎", "虎扑", "豆瓣"] as const;
  const tasks: Promise<CrawlerHit[]>[] = [
    fetchPlatform("weibo", core, limit, timeoutMs),
    fetchPlatform("tieba", core, limit, timeoutMs),
    fetchPlatform("zhihu", core, limit, timeoutMs),
    // 新增两路供给量控制小些（各4），社区帖总配额在 chat 合并层兜底
    fetchHupu(core, Math.min(4, limit), timeoutMs),
    fetchDouban(core, Math.min(4, limit), timeoutMs),
  ];
  const settled = await Promise.allSettled(tasks);
  const hits: CrawlerHit[] = [];
  const seen = new Set<string>();
  const stats: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      let kept = 0;
      let dropped = 0;
      for (const h of s.value) {
        if (seen.has(h.url)) continue;
        // 词面相关性门控：用剥壳后的检索短语 + 语境词；把来源论坛/版块名拼进
        // 标题一起判——圈子帖标题常不写圈子名，版块名本身就是语境。
        const gateText = `${h.title} ${h.source || ""}`;
        if (!titleRelevant(gateText, plan.main, plan.context)) {
          dropped++;
          continue;
        }
        seen.add(h.url);
        hits.push(h);
        kept++;
      }
      stats.push(
        dropped ? `${labels[i]}${kept}条(滤${dropped})` : `${labels[i]}${s.value.length}条`
      );
      recordCrawlerHealth(labels[i], true, kept > 0 ? "" : "0条（无相关内容）");
    } else {
      const msg = (s.reason as Error)?.message || String(s.reason);
      stats.push(`${labels[i]}失败(${msg})`);
      recordCrawlerHealth(labels[i], false, msg);
    }
  });

  if (hits.length > 0) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), hits });
  } else {
    console.warn(`[crawler] 五平台皆空 q=${core}: ${stats.join(" / ")}`);
  }
  return hits;
}
