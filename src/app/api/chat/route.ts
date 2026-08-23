import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";
// 本地 DailyHotApi 地址（需先部署，见说明）
const DAILYHOT_BASE = process.env.DAILYHOT_BASE_URL || "http://localhost:6688";

// 自建 SearXNG（部署在腾讯云 VPS）——小众领域今日无实时热点时，用它检索近30天内容兜底
const SEARXNG_URL = (process.env.SEARXNG_URL || "").replace(/\/+$/, "");
const SEARXNG_TOKEN = process.env.SEARXNG_TOKEN || "";

// ========== 带超时的 fetch ==========
async function fetchWithTimeout(url: string, options: any = {}, timeout = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ========== Platform Fetchers ==========

// URL → 简明来源标签（近30天兜底结果里给用户看来源用）
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 近30天搜索式发现：某锁定领域今日各平台实时热榜筛选后无相关热点时，
// 用 SearXNG（time_range=month）检索该领域近一个月内的相关内容作为兜底。
async function searxRecentSearch(
  query: string,
  limit = 12,
  timeRange: "day" | "week" | "month" | "year" | "" = "month"
): Promise<{ title: string; url: string; source: string }[]> {
  if (!SEARXNG_URL) return [];
  const tr = timeRange ? `&time_range=${timeRange}` : "";
  const u =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}` +
    `&format=json&language=zh-CN&safesearch=0${tr}&categories=general`;
  const res = await fetchWithTimeout(
    u,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        // 反代校验用的共享密钥
        ...(SEARXNG_TOKEN ? { "X-Detail-Token": SEARXNG_TOKEN } : {}),
      },
    },
    9000
  );
  const json: any = await res.json();
  const out: { title: string; url: string; source: string }[] = [];
  const seen = new Set<string>();
  for (const r of json?.results || []) {
    const url: string = r?.url || "";
    const title: string = (r?.title || "").trim();
    if (!title || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    // 跳过百科/词典/搜索引擎自身页面，只留真正的报道/内容
    if (
      /baike\.baidu\.com|wikipedia\.org|zhihu\.com\/topic|baidu\.com\/s\?|bing\.com\/search|google\.[a-z.]+\/search/.test(
        url
      )
    )
      continue;
    seen.add(url);
    out.push({ title, url, source: hostLabel(url) });
    if (out.length >= limit) break;
  }
  return out;
}

// 通用：按优先级依次尝试多个数据源，全部失败返回错误提示
async function tryFetchSources(sources: (() => Promise<any[]>)[], platform: string): Promise<any[]> {
  for (const source of sources) {
    try {
      const result = await source();
      if (result && result.length > 0 && !result[0]?.error) return result;
    } catch {}
  }
  return [{ error: `${platform}，请确认 DailyHotApi 服务正在运行` }];
}



async function fetchWeiboHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/weibo`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0,
        url: item.url || item.mobileUrl || "",
      }));
    },
    async () => {
      // 源2（备用）：微博官方 Ajax 接口
      const res = await fetchWithTimeout("https://weibo.com/ajax/side/hotSearch", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://weibo.com/" },
      });
      const json = await res.json();
      const list = json?.data?.realtime || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.word || item.note, hot: item.num || 0,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word || item.note)}`,
      }));
    },
  ], "微博热搜暂时无法获取，建议稍后重试");
}

async function fetchZhihuHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/zhihu`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, excerpt: item.desc || "",
        hot: item.hot || "", url: item.url || "",
      }));
    },
    async () => {
      // 源2（备用）：知乎官方 API
      const res = await fetchWithTimeout("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.target?.title || "未知",
        excerpt: item.target?.excerpt?.slice(0, 80) || "",
        hot: item.detail_text || "",
        url: `https://www.zhihu.com/question/${item.target?.id || ""}`,
      }));
    },
  ], "知乎热榜暂时无法获取，建议稍后重试");
}

async function fetchBilibiliHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：B站官方热门 API（已确认可用）
      const res = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const json = await res.json();
      const list = json?.data?.list || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, author: item.owner?.name || "",
        view: item.stat?.view || 0, url: `https://www.bilibili.com/video/${item.bvid}`,
      }));
    },
    async () => {
      // 源2：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/bilibili`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, author: item.author || "",
        view: item.hot || 0, url: item.url || "",
      }));
    },
  ], "B站热榜暂时无法获取，建议稍后重试");
}

async function fetchDouyinHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/douyin`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || "",
      }));
    },
    async () => {
      // 源2（备用）：抖音官方热搜 API
      const res = await fetchWithTimeout("https://www.douyin.com/aweme/v1/web/hot/search/list/", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const json = await res.json();
      const list = json?.data?.word_list || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.word || "未知", url: "",
      }));
    },
  ], "抖音热榜暂时无法获取，建议稍后重试");
}

async function fetchXiaohongshuHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：小红书官方热搜接口
      const res = await fetchWithTimeout("https://edith.xiaohongshu.com/api/sns/v1/search/hot_list", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.xiaohongshu.com/",
          "Origin": "https://www.xiaohongshu.com",
        },
      });
      const json = await res.json();
      const list = Array.isArray(json?.data?.items)
        ? json.data.items
        : Array.isArray(json?.data)
        ? json.data
        : [];
      const items = list
        .map((item: any) => item.title || item.name || item.word || "")
        .filter((t: string) => t.trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((title: string, i: number) => ({
        rank: i + 1, title,
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`,
      }));
    },
    async () => {
      // 源2：小红书前端页面热搜（备选）
      const res = await fetchWithTimeout("https://www.xiaohongshu.com/explore", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      const text = await res.text();
      // 尝试从页面中提取热搜关键词
      const matches = [...text.matchAll(/"keyword":"(.*?)"/g)];
      const unique = [...new Set(matches.map(m => m[1]))].filter(t => t.trim());
      if (unique.length < 5) throw new Error("empty");
      return unique.slice(0, 20).map((title: string, i: number) => ({
        rank: i + 1, title,
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`,
      }));
    },
    async () => {
      // 源3：什么值得买热榜（种草/好物/生活方式，与小红书调性最接近，作为替代数据源）
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/smzdm`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || item.mobileUrl || "",
        note: "数据来源：什么值得买热榜（小红书无公开接口，用种草/生活方式内容替代）",
      }));
    },
  ], "小红书热榜暂时无法获取，建议稍后重试");
}

async function fetchToutiaoHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/toutiao`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
      }));
    },
    async () => {
      // 源2（备用）：百度热搜
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/baidu`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
        note: "数据来源：百度热搜（头条接口暂不可用时的替代）",
      }));
    },
  ], "头条热榜暂时无法获取，建议稍后重试");
}

async function fetchBaiduHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/baidu`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
      }));
    },
    async () => {
      // 源2（备用）：百度热搜榜单官方 API（top.baidu.com，国内可直连）
      const res = await fetchWithTimeout(
        "https://top.baidu.com/api/board?platform=wise&tab=realtime",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://top.baidu.com/" } }
      );
      const json = await res.json();
      // cards[].content 里可能直接是词条，也可能再嵌一层 content
      const raw: any[] = [];
      for (const card of json?.data?.cards || []) {
        for (const sub of card?.content || []) {
          if (sub?.word || sub?.query) raw.push(sub);
          else if (Array.isArray(sub?.content)) raw.push(...sub.content);
        }
      }
      const items = raw.filter((x: any) => x.word || x.query);
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1,
        title: item.word || item.query,
        hot: item.hotScore || 0,
        url:
          item.rawUrl ||
          item.url ||
          `https://www.baidu.com/s?wd=${encodeURIComponent(item.word || item.query || "")}`,
      }));
    },
    async () => {
      // 源3（兜底）：今日头条热榜（百度接口全部失效时的替代）
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/toutiao`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
        note: "数据来源：今日头条热榜（百度接口暂不可用时的替代）",
      }));
    },
  ], "百度热搜暂时无法获取，建议稍后重试");
}

const PLATFORM_FETCHERS: Record<string, () => Promise<any[]>> = {
  微博: fetchWeiboHot,
  知乎: fetchZhihuHot,
  B站: fetchBilibiliHot,
  抖音: fetchDouyinHot,
  小红书: fetchXiaohongshuHot,
  头条: fetchToutiaoHot,
  百度: fetchBaiduHot,
};

// ========== Tools Definition ==========

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "fetch_hot_topics",
      description: "从指定平台抓取当前热点话题列表",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["微博", "知乎", "B站", "抖音", "小红书", "头条", "百度"],
            description: "目标平台名称",
          },
        },
        required: ["platform"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "filter_hot_by_domain",
      description: "根据用户创作领域，从热点列表中筛选出相关话题",
      parameters: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: { type: "object" },
            description: "热点话题列表",
          },
          domain: { type: "string", description: "用户的创作领域" },
        },
        required: ["topics", "domain"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_video_script",
      description: "根据热点话题生成短视频脚本（含Hook、痛点、内容、CTA结构）",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "选定的热点话题标题" },
          domain: { type: "string", description: "创作领域" },
          style: { type: "string", description: "脚本风格，如：口播、剧情、知识分享" },
        },
        required: ["topic", "domain"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_recent_topics_by_domain",
      description:
        "当某个已锁定的小众/垂直领域（如「反bl」）在今日各平台实时热榜里【逐条筛选后一条相关的都没有】时，用它检索该领域近一个月（近30天）内的相关内容作为兜底，返回近30天相关话题列表。仅在今日实时热榜确实无该领域相关热点时调用。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "要检索近30天内容的领域词，例如「反bl」",
          },
        },
        required: ["domain"],
      },
    },
  },
];
// ========== System Prompt ==========

// 含义不明确/小众/缩写型领域词的精确释义，避免模型自行臆测宽泛含义而滥打标签
// queries：用于近30天兜底检索的真实世界关键词。领域词本身可能是用户自造的窄词
// （如「反bl」现实中没人会这么写标题），必须展开成人们真正会用的措辞去 SearXNG 检索。
const DOMAIN_GLOSSARY: { test: RegExp; note: string; queries?: string[] }[] = [
  {
    test: /反\s*bl|反耽美|反\s*boys?['']?\s*love/i,
    note: "特指反对/批评「男男同性恋爱（BL / 耽美 / Boys' Love）」题材的内容，比如反对耽改剧、BL 小说、BL 同人、腐文化等。判定要极窄：只有当热点的核心话题就是在讨论 BL / 耽美这类题材本身（或明确反对这类题材）时才打这个标签。女性成长、女性权益、职场、婚恋、诈骗、社会新闻等，只要不是在直接讲 BL / 耽美题材，就【绝对不要】打【反bl】。更不要把「反bl」臆测成'反被规训 / 反凝视 / 反刻板印象'之类的宽泛含义去硬套到大量热点上。",
    queries: [
      "耽改剧 下架",
      "耽美 整改",
      "抵制 耽美",
      "腐文化 争议",
      "BL 影视 争议",
      "反对 耽改",
      "耽美 danmei 争议",
    ],
  },
];

// 兜底发现：把领域词拆解成一组相关检索词（命中 glossary 用其 queries，如「反bl」→反耽美/耽改剧下架/抵制耽美…；
// 否则退回领域词本身），逐个跑 SearXNG 聚合去重。
// ⚠️ SearXNG 的 time_range 过滤很激进：很多引擎不返回日期，会被 time_range 直接过滤成 0 条——
// 这正是"一个月都没有返回结果"的根因。所以这里【渐进放宽】：近一个月 → 近一年 → 不限时间，
// 只要总量还不够就继续放宽，保证能拿到相关内容。
async function findRecentByDomain(
  domain: string,
  limit = 12
): Promise<{ title: string; url: string; source: string }[]> {
  const d = domain.trim();
  if (!d) return [];
  const hit = DOMAIN_GLOSSARY.find((g) => g.test.test(d));
  const queries = hit?.queries?.length ? hit.queries : [d];

  const collect = async (
    timeRange: "month" | "year" | ""
  ): Promise<{ title: string; url: string; source: string }[]> => {
    const merged: { title: string; url: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      const items = await searxRecentSearch(q, limit, timeRange);
      for (const it of items) {
        if (it.url && !seen.has(it.url)) {
          seen.add(it.url);
          merged.push(it);
        }
      }
      if (merged.length >= limit) break;
    }
    return merged.slice(0, limit);
  };

  // 渐进放宽：近一个月 → 近一年 → 不限时间，累计去重，够 3 条就停。
  const out: { title: string; url: string; source: string }[] = [];
  const seen = new Set<string>();
  for (const tr of ["month", "year", ""] as const) {
    const batch = await collect(tr);
    for (const it of batch) {
      if (it.url && !seen.has(it.url)) {
        seen.add(it.url);
        out.push(it);
      }
      if (out.length >= limit) break;
    }
  if (out.length >= 3) break; // 已经拿到足够结果，不再继续放宽
  }
  return out.slice(0, limit);
}

// 兜底安全网：模型有时嘴上说"该领域今日无热点"却【没真的调用】兜底工具，导致气泡框不出现。
// 这里对每个"已锁定且命中内置小众词表"的领域（如「反bl」）主动补跑一次拆词检索，
// 把结果并入 recentFallback，保证只要有相关内容，气泡框就一定会出现。
async function ensureNicheFallback(
  domain: string,
  current: {
    domain: string;
    items: { title: string; url: string; source: string }[];
  } | null
) {
  const domainList = (domain || "")
    .split(/[、，,\/\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  let fb = current;
  for (const d of domainList) {
    const hit = DOMAIN_GLOSSARY.find((g) => g.test.test(d));
    if (!hit) continue; // 只对内置小众词表里的领域主动兜底
    if (fb && fb.domain.split("、").includes(d)) continue; // 模型已针对该领域补过
    const items = await findRecentByDomain(d, 12);
    if (items.length === 0) continue;
    if (!fb) fb = { domain: "", items: [] };
    const seen = new Set(fb.items.map((x) => x.url));
    for (const it of items) {
      if (it.url && !seen.has(it.url)) {
        seen.add(it.url);
        fb.items.push(it);
      }
    }
    if (!fb.domain.split("、").includes(d)) {
      fb.domain = fb.domain ? `${fb.domain}、${d}` : d;
    }
  }
  return fb;
}

function buildSystemPrompt(
  domain: string,
  platforms: string[],
  userGlossary: Record<string, string> = {}
) {
  const domainHint = domain
    ? `用户的创作领域是「${domain}」。`
    : `用户未指定创作领域，如果用户在消息中提到领域相关信息，请据此筛选。`;

  // 把"女性成长、反bl"这类多领域串拆成单个领域，用于生成正/反例，避免模型把它们粘成一个标签
  const domainList = domain
    .split(/[、，,\/\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const rightExample = domainList.map((d) => `【${d}】`).join("");
  const wrongExample = `【${domainList.join("、")}】`;

  // 针对含义不明确的领域词注入精确释义，避免模型臆测滥打标签。
  // 优先用用户在界面上为该领域填写的释义；没有再回退到内置 DOMAIN_GLOSSARY。
  const glossaryLines = domainList
    .map((d) => {
      const userNote = (userGlossary[d] || "").trim();
      if (userNote) return `- 「${d}」的准确含义：${userNote}`;
      const hit = DOMAIN_GLOSSARY.find((g) => g.test.test(d));
      return hit ? `- 「${d}」的准确含义：${hit.note}` : "";
    })
    .filter(Boolean);
  const glossaryBlock = glossaryLines.length
    ? `\n- ⚠️ 领域含义说明（务必按这个含义判断，不要自行臆测）：\n${glossaryLines.join("\n")}`
    : "";

  // 展示规范：是否锁定了领域，走两套完全不同的输出逻辑
  const displayRule = domain
    ? `展示热点的输出规范（用户已锁定领域「${domain}」，务必严格执行）：
- ⚠️ 这是硬性过滤，不是排序建议：抓取到每个平台的热点后，你【必须】逐条判断它是否真正属于「${domain}」，【只列出】真正属于「${domain}」的热点，其余一律【不要出现在回复里】。绝对不允许把不相关的热点也列出来再打别的标签。
- 相关性从严：热点的核心话题必须确实落在「${domain}」范围内，或能直接明确地服务于「${domain}」的选题。不要靠牵强延伸、间接联想硬凑（例如领域「美食探店」，机器人/选举/地缘政治都不算）。宁可一条都不给，也不要给不相关的。
- 保留下来的每条热点，后面只标注它【真正属于】的那个领域；标签只能从用户所选的领域（${domain}）里挑，不要用其它标签体系。
- ⚠️ 每个领域必须用【独立的】书名号括起来，一个领域一个【】。绝对禁止把多个领域塞进同一个【】里。错误写法：${wrongExample}；正确写法：${rightExample}（这条同时属于多个领域时才这样写）。
- ⚠️ 严禁给每条热点都打上完全相同的一组标签：用户选了多个领域时，绝大多数热点只真正属于其中【一个】领域，你要逐条独立判断，只标它确实属于的那个。如果你发现自己给几乎每一条都打了同样的标签组合，这几乎一定是判断错了，请推翻重来。比如一条只讲女性个人成长/女性权益的热点，就只标【女性成长】，与「反bl」无关时绝不能加【反bl】。
- ⚠️ 对含义不明确、小众或用缩写表示的领域词（例如「反bl」），只有当热点的核心内容明确、直接就是在讲这个主题时才打该标签；只要有一点不确定，就【不要】打这个标签，也不要用你自己臆测的宽泛含义（如把它当成"反被规训/反凝视"之类）去硬套到大量热点上。
- 按相关度从高到低排序，最相关的在最前并在标题前加 ⭐。
- 如果某平台筛选后没有任何属于「${domain}」的热点，就直接写"该平台今日暂无与「${domain}」相关的热点"，不要用无关内容填充。
- 格式示例：1. ⭐ 某条只关乎${domainList[0] || "该领域"}的热点 【${domainList[0] || "该领域"}】${glossaryBlock}`
    : `展示热点的输出规范（用户未锁定领域，全部展示并归类）：
- 列出各平台抓到的全部热点，按平台热度原顺序展示，不做筛选和重排。
- 每一条热点后面都要用【】标注它所属的创作领域标签，可以多标（一条热点可同时属于多个领域）；每个领域用独立的【】，不要塞进同一个【】。
- 领域标签从以下集合中选取：科技数码、职场成长、美食探店、娱乐八卦、财经理财、健康养生、教育学习、旅行出行；若都不贴合，可补充一个最贴切的自定义标签。
- 格式示例：1. 某热点标题 【职场成长】【财经理财】`;

  return `你是一个专业的自媒体热点分析 Agent。${domainHint}目标平台是：${platforms.join("、")}。
${
  domain
    ? `\n🔒【领域锁定 = 最高优先级，凌驾于用户本次说法之上】用户已在界面锁定创作领域「${domain}」。这是一个持续生效的硬性过滤器：无论用户这次说的是"抓取热点""抓今日热点""全量热榜""原始热点"还是任何类似说法，你最终展示给用户的内容都【必须】只保留真正属于「${domain}」的热点，其余一律丢弃、不得出现。抓取阶段可以照常抓全量，但【展示前必须按领域过滤】。绝对不允许因为用户说了"抓取/全量/原始/不做额外操作"就把所有平台的热点原样堆出来——那是错误行为。\n- ⚠️【当前领域集合是唯一权威，以本条为准】本次锁定的领域【完整清单】就是：${domainList.map((d) => `「${d}」`).join("、")}，共 ${domainList.length} 个。用户随时可能在界面上增删领域，所以【对话历史里出现过的领域组合可能已经过期】。你【必须】以本条系统提示里的这份清单为准，对清单里的【每一个】领域都主动去抓取、筛选、归类——包括刚新增的领域。绝对不要沿用你之前回复里用过的旧领域集合。\n- ⚠️【每次抓取都要真跑，禁止偷懒复用】只要用户要求抓取/刷新/再来一次，你就【必须】重新调用 fetch_hot_topics 并按当前完整领域清单重新过滤，输出全新结果。【严禁】回复"无变化""仍是N条""数据没更新""内容重复""与其让你等待"这类话，也【严禁】直接把上一轮的列表原样再贴一遍——因为用户很可能刚改动了所选领域，"无变化"几乎一定是错的。\n- 🆕【小众领域今日无热点时，自动做近30天兜底】如果某个锁定领域（尤其是小众/垂直领域，如「反bl」）在今日各平台实时热榜里【逐条筛选后一条相关的都没有】，你【必须】调用 search_recent_topics_by_domain(domain) 检索该领域近30天内的相关内容作为兜底，把它作为「近30天相关话题」补充给用户，并在回复里明确标注这些是"📌 近30天相关内容（非今日实时热榜）"。不要因为今日没热点就只回一句"暂无相关热点"草草了事。\n`
    : ""
}
你的能力：
1. fetch_hot_topics: 从微博、知乎、B站、抖音、小红书、头条、百度抓取实时热点
2. filter_hot_by_domain: 用 AI 判断哪些热点和用户领域相关
3. generate_video_script: 根据热点生成短视频脚本（Hook → 痛点 → 内容 → CTA）
4. search_recent_topics_by_domain: 小众/垂直领域今日实时热榜无相关热点时，检索该领域近30天内容做兜底

工作流程：
- 用户说"抓热点"时，依次调用各平台的 fetch_hot_topics${
    domain ? "；抓完后必须按锁定领域过滤再展示，不能直接堆全量" : ""
  }
- 用户说"筛选"或"相关"时，调用 filter_hot_by_domain，从用户消息中推断领域
- 用户说"生成脚本"或"写脚本"时，调用 generate_video_script
- 你也可以自主判断，一次性完成 抓取→筛选→生成 的完整流程

${displayRule}

⚠️【展示格式硬性要求，必须遵守】
- 展示热点列表时，【禁止使用 Markdown 表格】（即禁止出现 | 平台 | 热点 | 标签 | 这种竖线表格）。前端无法把表格里的标签正确渲染成独立胶囊，也无法挂载"查看详情"按钮。
- 每一条热点【必须独占一行】，格式固定为："序号. 平台｜标题 【标签1】【标签2】"，例如：1. 知乎｜某条热点标题 【女性成长】。
- 每个领域标签都要用【独立的】书名号，一个领域一个【】，绝对不能写成【女性成长、反bl】这种粘在一起的形式；正确是【女性成长】【反bl】。
- 绝大多数热点只属于其中一个领域，逐条独立判断，不要给每条都打上完全相同的一组标签。

回复使用中文，格式清晰，善用 emoji 让内容更生动。`;
}

// ========== Tool Execution ==========

async function executeTool(
  name: string,
  args: any,
  domain: string
): Promise<string> {
  switch (name) {
    case "fetch_hot_topics": {
      const platform = args.platform as string;
      const fetcher = PLATFORM_FETCHERS[platform];
      if (!fetcher) return JSON.stringify({ error: `不支持的平台: ${platform}` });
      const topics = await fetcher();
      return JSON.stringify(topics, null, 2);
    }
    case "filter_hot_by_domain": {
      // Use LLM to filter topics
      const filterPrompt = `你是领域筛选助手。从以下热点中，选出真正属于「${args.domain || domain}」领域的话题。
相关性判断要「从严」：热点的核心话题必须确实落在该领域范围内，或能直接、明确地服务于该领域的创作选题；不要靠牵强的延伸或间接联想来硬凑相关。宁可少选，也不要选进不相关的。
数量不设固定上限，有几个真正相关的就返回几个（可能只有 1-2 个，也可能 8 个以上），按相关度从高到低排序；如果一个都不相关，就返回空数组 []。
只返回 JSON 数组，每项包含 rank, title, reason(为什么真正属于该领域)。

热点列表：
${JSON.stringify(args.topics, null, 2)}`;
      const filterRes = await callLLM([{ role: "user", content: filterPrompt }], false);
      return filterRes;
    }
    case "generate_video_script": {
      const scriptPrompt = `你是爆款短视频编剧。请根据以下信息生成一个短视频脚本：

话题：${args.topic}
领域：${args.domain || domain}
风格：${args.style || "口播知识分享"}

脚本结构要求：
1. 🎣 Hook（前3秒抓住注意力的开场）
2. 💢 痛点（观众的痛点/好奇心）
3. 💡 内容（核心价值输出，3-5个要点）
4. 📢 CTA（引导互动的结尾）

字数控制在300-500字，口语化，有节奏感。`;
      const scriptRes = await callLLM([{ role: "user", content: scriptPrompt }], false);
      return scriptRes;
    }
    case "search_recent_topics_by_domain": {
      const d = (args.domain || domain || "").toString().trim();
      if (!d)
        return JSON.stringify({ domain: "", range: "近30天", realtime: false, items: [] });
      const items = await findRecentByDomain(d, 12);
      return JSON.stringify(
        { domain: d, range: "近30天", realtime: false, items },
        null,
        2
      );
    }
    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}

// ========== LLM Call ==========

async function callLLM(
  messages: any[],
  useTools: boolean = true
): Promise<any> {
  const body: any = {
    model: OPENAI_MODEL,
    messages,
  };
  if (useTools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
  }
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!useTools) {
    return json.choices?.[0]?.message?.content || "";
  }
  return json.choices?.[0]?.message;
}
// ========== API Route Handler ==========

export async function POST(req: NextRequest) {
  try {
    const { messages, domain, platforms, glossary } = await req.json();

    if (!OPENAI_API_KEY) {
      return NextResponse.json({
        content: "⚠️ 服务端未配置 OPENAI_API_KEY，请联系管理员。",
        toolLogs: [],
      });
    }

    const systemMsg = {
      role: "system",
      content: buildSystemPrompt(
        domain,
        platforms,
        glossary && typeof glossary === "object" ? glossary : {}
      ),
    };

    let conversationMessages = [systemMsg, ...messages];
    const toolLogs: string[] = [];
    // 近30天兜底：小众领域今日无热点时，search_recent_topics_by_domain 的结果收集到这里，
    // 随响应一起返回给前端，用「气泡框」提示用户。
    let recentFallback: {
      domain: string;
      items: { title: string; url: string; source: string }[];
    } | null = null;
    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const assistantMessage = await callLLM(conversationMessages, true);

      if (!assistantMessage) {
        return NextResponse.json({
          content: "LLM 返回为空，请检查 API Key 是否正确或余额是否充足。",
          toolLogs,
        });
      }

      // If no tool calls, return the final text
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        // 安全网：小众领域即使模型没调兜底工具，也主动补一次拆词检索
        recentFallback = await ensureNicheFallback(domain, recentFallback);
        return NextResponse.json({
          content: assistantMessage.content || "完成。",
          toolLogs,
          recentFallback,
        });
      }

      // Process tool calls
      conversationMessages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(toolCall.function.arguments || "{}");
        } catch {}

        toolLogs.push(`调用 ${fnName}(${fnArgs.platform || fnArgs.topic || fnArgs.domain || ""})`);

        const result = await executeTool(fnName, fnArgs, domain);

        // 收集近30天兜底结果（可能针对多个小众领域被调用多次，合并去重）
        if (fnName === "search_recent_topics_by_domain") {
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
              if (!recentFallback) recentFallback = { domain: "", items: [] };
              const seen = new Set(recentFallback.items.map((x) => x.url));
              for (const it of parsed.items) {
                if (it?.url && !seen.has(it.url)) {
                  seen.add(it.url);
                  recentFallback.items.push(it);
                }
              }
              const dm = (parsed.domain || "").toString().trim();
              if (dm && !recentFallback.domain.split("、").includes(dm)) {
                recentFallback.domain = recentFallback.domain
                  ? `${recentFallback.domain}、${dm}`
                  : dm;
              }
            }
          } catch {}
        }

        conversationMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // If we hit max iterations, get a final summary
    conversationMessages.push({
      role: "user",
      content: "请总结以上所有工具调用的结果，给出最终回复。",
    });
    const finalMsg = await callLLM(conversationMessages, false);

    // 安全网：小众领域即使模型没调兜底工具，也主动补一次拆词检索
    recentFallback = await ensureNicheFallback(domain, recentFallback);

    return NextResponse.json({
      content: finalMsg || "已完成处理。",
      toolLogs,
      recentFallback,
    });
  } catch (e: any) {
    return NextResponse.json(
      { content: `服务错误: ${e.message}`, toolLogs: [] },
      { status: 500 }
    );
  }
}