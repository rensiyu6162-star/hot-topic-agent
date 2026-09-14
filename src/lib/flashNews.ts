// 快讯补充检索路（2026-09）：财联社电报 / 华尔街见闻 / 财新 / 格隆汇 / 澎湃新闻。
// 定位：财经与时政的专业快讯源，是通用搜索引擎（baidu/bing/chinaso）索引慢、排序靠后的
// 内容盲区——detail 召回此前拿不到，作为与 searx/平台内爬虫平级的一路来源并入候选池
// （参考网站 + 报道取材）。相关话题命不命中由调用方（detail 路由 relevanceScore）过滤，
// 本模块只负责拉全量并去重。
// 数据面（2026-09-10 实测）：自建 RSSHub 的 /cls/telegraph、/wallstreetcn/live/global、
// /caixin/latest、/gelonghui/live（RSS XML）；DailyHotApi /thepaper（JSON）。
// 财联社官方 nodeapi 需签名（返回 HTML 壳）、澎湃官方热榜 API 需签名、RSSHub 无澎湃路由
// （404）——各源只此一条稳定路径。五源并发 + 5 分钟缓存，单源失败静默降级不拖主链路。

import type { SearxHit } from "./searx";

const RSSHUB_BASE = (
  process.env.RSSHUB_BASE_URL || "http://localhost:1200"
).replace(/\/+$/, "");
const DAILYHOT_BASE =
  process.env.DAILYHOT_BASE_URL || "http://localhost:6688";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CACHE_TTL_MS = 5 * 60 * 1000;
// 挂 globalThis（原因同 searx.ts：route bundle 各持模块副本，不挂全局缓存无法跨 route 复用）
const g = globalThis as unknown as {
  __HT_FLASH_CACHE__?: Map<string, { at: number; hits: SearxHit[] }>;
};
const cache = (g.__HT_FLASH_CACHE__ ??= new Map());

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// XML 实体/CDATA 解码 + 去 HTML 标签（华尔街见闻 description 带 <p>，财新带富文本）
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 极简 RSS 解析：只取 title/link/description/pubDate（与 chat 路由 rsshubFetch 同套路，
// 这里多取 pubDate 供新鲜度分层）。fallbackUrl：财联社 <link/> 为空时回退栏目页。
function rssToHits(xml: string, limit: number, fallbackUrl?: string): SearxHit[] {
  const out: SearxHit[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && out.length < limit) {
    const block = m[1];
    const t = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const l = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const d = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
    const p = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    const title = decodeXml(t);
    if (!title) continue;
    const rawUrl = decodeXml(l);
    const url = /^https?:\/\//.test(rawUrl) ? rawUrl : fallbackUrl || "";
    if (!url) continue;
    const ts = p ? new Date(p).getTime() : NaN;
    out.push({
      title: title.slice(0, 120),
      url,
      content: decodeXml(d).slice(0, 200),
      ...(Number.isFinite(ts)
        ? { published: new Date(ts).toISOString().slice(0, 10) }
        : {}),
    });
  }
  return out;
}

// 五源并发拉取 + 跨源按 URL 去重
async function fetchAll(): Promise<SearxHit[]> {
  const sources: Promise<SearxHit[]>[] = [
    fetchText(`${RSSHUB_BASE}/cls/telegraph`)
      .then((x) => rssToHits(x, 30, "https://www.cls.cn/telegraph"))
      .catch(() => [] as SearxHit[]),
    fetchText(`${RSSHUB_BASE}/wallstreetcn/live/global`)
      .then((x) => rssToHits(x, 30))
      .catch(() => [] as SearxHit[]),
    fetchText(`${RSSHUB_BASE}/caixin/latest`)
      .then((x) => rssToHits(x, 30))
      .catch(() => [] as SearxHit[]),
    fetchText(`${RSSHUB_BASE}/gelonghui/live`)
      .then((x) => rssToHits(x, 30))
      .catch(() => [] as SearxHit[]),
    fetchText(`${DAILYHOT_BASE}/thepaper`)
      .then((x) => {
        const json = JSON.parse(x);
        const list = Array.isArray(json?.data) ? json.data : [];
        return list
          .slice(0, 30)
          .map((item: any): SearxHit => {
            const ts = item?.timestamp ? Number(item.timestamp) : NaN;
            return {
              title: (item?.title || "").toString().trim().slice(0, 120),
              url: (item?.url || item?.mobileUrl || "").toString(),
              content: (item?.desc || "").toString().slice(0, 200),
              ...(Number.isFinite(ts) && ts > 0
                ? { published: new Date(ts).toISOString().slice(0, 10) }
                : {}),
            };
          })
          .filter((h: SearxHit) => h.title && h.url);
      })
      .catch(() => [] as SearxHit[]),
  ];
  const settled = await Promise.allSettled(sources);
  const seen = new Set<string>();
  const out: SearxHit[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const h of s.value) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      out.push(h);
    }
  }
  return out;
}

// 对外入口：返回全部快讯条目（已去重），limit 截断
export async function flashNewsSearch(limit = 40): Promise<SearxHit[]> {
  const cached = cache.get("all");
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.hits.slice(0, limit);
  }
  const hits = await fetchAll();
  if (hits.length > 0) {
    if (cache.size >= 20) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set("all", { at: Date.now(), hits });
  }
  return hits.slice(0, limit);
}
