import { NextRequest, NextResponse } from "next/server";
import {
  pickRelevantTemplates,
  renderTemplates,
} from "../_shared/templates";

// 爆款口播模板：由 collector/analyze_scripts.py 从真实高播放口播文稿拆解而来。
// 生成脚本时按领域取样，作为"参考爆款样例"喂给模型仿写，而非套空结构。
// 读取与挑选逻辑已抽到 ../_shared/templates.ts，与 api/script 路由共用。

// 把本路由的 callLLM 适配成 _shared/templates 需要的「给 prompt、返回文本」形态。
const plainLLM = (prompt: string): Promise<string> =>
  callLLM([{ role: "user", content: prompt }], false) as Promise<string>;



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
// 成人/SEO 垃圾站兜底黑名单：无释义的模糊领域今日无热点时，SearXNG 常把这类
// 内容农场/成人资源站顶上来（标题多为"免费成人视频/在线观看/无码/番号入口"等）。
// 相关性过滤只在有精确释义时才跑，兜不住它们，所以在检索源头按【标题关键词】直接丢弃。
const JUNK_TITLE_RE =
  /成人|在线观看|无码|高清资源|免费观看|性爱|裸体|色情|情色|番号|做爱|三级片|自慰|一区二区|入口18|漫画网址|完整版在线|免费下载|磁力|种子下载|av在线|18\+/i;

function isJunkResult(title: string, url: string): boolean {
  if (JUNK_TITLE_RE.test(title)) return true;
  // 标题里被 ❌/✖ 之类符号打码的（前端截图里的 m.blog.* 垃圾站特征），一律视为垃圾
  if (/[✖❌⚠]{1,}/.test(title) && /blog\./i.test(url)) return true;
  return false;
}

async function searxRecentSearch(
  query: string,
  limit = 12,
  timeRange: "day" | "week" | "month" | "year" | "" = "month"
): Promise<{ title: string; url: string; source: string }[]> {
  if (!SEARXNG_URL) return [];
  const tr = timeRange ? `&time_range=${timeRange}` : "";
  // safesearch=1（中等）：过滤明显成人内容，又不至于像 2 那样误伤正常检索。
  const u =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}` +
    `&format=json&language=zh-CN&safesearch=1${tr}&categories=general`;
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
    // 跳过成人/SEO 垃圾内容农场（模糊领域无释义时最容易被顶上来）
    if (isJunkResult(title, url)) continue;
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
      // 源1：微博官方 Ajax 接口（实测可用）。
      // ⚠️ 顺序有意把它放前面：DailyHotApi 的 /weibo 实测已返回 HTTP 500，
      // 放前面等于每次请求先白跑一个失败往返。
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
    async () => {
      // 源2（备用）：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/weibo`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0,
        url: item.url || item.mobileUrl || "",
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
      // 源2（备用·独立于 DailyHotApi）：知乎移动端 API。
      // ⚠️ 原来这里用 www.zhihu.com/api/v3/feed/topstory/hot-lists/total，实测已返回 401 未授权，
      // 等于知乎位没有任何备用源。api.zhihu.com 这条移动端接口无需登录，实测 30 条可用。
      const res = await fetchWithTimeout("https://api.zhihu.com/topstory/hot-lists/total?limit=20", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1,
        title: item.target?.title || "未知",
        excerpt: item.target?.excerpt?.slice(0, 80) || "",
        hot: item.detail_text || "",
        // ⚠️ 别用 target.id 拼链接：知乎新问题 id 已超过 JS 安全整数范围
        // （如 2076094940300272847），JSON.parse 会四舍五入成 ...273000，链接直接 404。
        // target.url 是字符串（api.zhihu.com/questions/xxx），无精度问题，只换域名。
        url: (item.target?.url || "").replace(
          "api.zhihu.com/questions/",
          "www.zhihu.com/question/"
        ) || `https://www.zhihu.com/question/${item.target?.id || ""}`,
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

const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 抖音三个非 DailyHotApi 源返回的都是 word_list 结构（word / hot_value / sentence_id），统一解析。
// sentence_id 存在时拼真实话题聚合页，否则退化成站内搜索页。
function parseDouyinWordList(list: any): any[] {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) throw new Error("empty");
  return items.slice(0, 20).map((item: any, i: number) => ({
    rank: i + 1,
    title: item.word || "未知",
    hot: item.hot_value || 0,
    url: item.sentence_id
      ? `https://www.douyin.com/hot/${item.sentence_id}`
      : `https://www.douyin.com/search/${encodeURIComponent(item.word || "")}`,
  }));
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
      // 源2（独立于 DailyHotApi）：抖音官方 web 热搜接口。
      // ⚠️ 关键：必须带 device_platform=webapp&aid=6383，否则返回 HTTP 200 但 body 为空
      // （之前误判这个接口"已失效"，其实只是缺参数）。实测 status_code=0、word_list 49 条。
      const res = await fetchWithTimeout(
        "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web",
        { headers: { "User-Agent": DOUYIN_UA, "Referer": "https://www.douyin.com/" } }
      );
      return parseDouyinWordList((await res.json())?.data?.word_list);
    },
    async () => {
      // 源3（独立主机）：抖音 App 端热搜接口（aweme.snssdk.com，与 www.douyin.com 不同域，
      // 主域被限时仍可能通）。实测 status_code=0、word_list 49 条，结构同源2。
      const res = await fetchWithTimeout(
        "https://aweme.snssdk.com/aweme/v1/hot/search/list/?device_platform=android&version_code=990&aid=1128",
        { headers: { "User-Agent": DOUYIN_UA } }
      );
      return parseDouyinWordList((await res.json())?.data?.word_list);
    },
    async () => {
      // 源4（免签名老接口）：iesdouyin 热搜榜。实测 status_code=0、word_list 50 条，
      // 但只给热词不给 sentence_id，链接会退化成站内搜索页。
      const res = await fetchWithTimeout(
        "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
        { headers: { "User-Agent": DOUYIN_UA, "Referer": "https://www.douyin.com/" } }
      );
      return parseDouyinWordList((await res.json())?.word_list);
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
    // ⚠️ 这里曾有个"源3"：小红书两路都失败时，改抓 DailyHotApi 的 /smzdm（什么值得买），
    // 挂在「小红书」名下只用一行 note 说明。已按"是什么源就什么源、出不了就别出、不做硬性替代"
    // 移除——小红书自己的源都不通时就如实报不可用；什么值得买已作为独立平台单列（fetchSmzdmHot）。
  ], "小红书热榜暂时无法获取（官方接口已限制访问）");
}

// 什么值得买：种草/好物/生活方式热榜，作为**独立平台**存在，
// 不再冒充小红书的替代数据。数据源目前只有 DailyHotApi。
async function fetchSmzdmHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/smzdm`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || item.mobileUrl || "",
      }));
    },
  ], "什么值得买热榜暂时无法获取，建议稍后重试");
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
      // 源2（备用·独立于 DailyHotApi）：今日头条官方热榜。
      // ⚠️ 原来这里退到 DailyHotApi 的 /baidu，两个源都走 DailyHotApi，它一挂头条位直接没数据；
      // 且 /baidu 实测只返回 1 条（形同失效）。改成头条官方 hot-board，实测 50 条可用。
      const res = await fetchWithTimeout("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.toutiao.com/",
        },
      });
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1,
        title: item.Title || "未知",
        hot: item.HotValue || 0,
        url: item.Url || `https://www.toutiao.com/trending/${item.ClusterIdStr || ""}/`,
      }));
    },
  ], "头条热榜暂时无法获取，建议稍后重试");
}

async function fetchBaiduHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：百度热搜榜单官方 API（top.baidu.com，国内可直连，实测可用）。
      // ⚠️ 顺序有意把它放前面：DailyHotApi 的 /baidu 实测只返回 1 条（total:1），
      // 必然被下面的 length<3 判定抛掉，放前面等于每次先白跑一个失败往返。
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
      // 源2（备用）：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/baidu`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
      }));
    },
    // ⚠️ 这里曾有个"源3"：百度两路都失败时改抓 DailyHotApi 的 /toutiao，挂在「百度」名下。
    // 已按"是什么源就什么源、出不了就别出、不做硬性替代"移除——头条数据本来就有独立的「头条」平台。
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
  什么值得买: fetchSmzdmHot,
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
            enum: ["微博", "知乎", "B站", "抖音", "小红书", "头条", "百度", "什么值得买"],
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
    // ⚠️ SearXNG 把空格分隔的词按 AND 处理，多词短语（如"耽美 danmei 争议"）会过度收窄、几乎搜不到东西。
    // 这里用【单个宽词】逐个检索，命中面更广；原始领域词（"反bl"）也会在 findRecentByDomain 里被优先检索。
    queries: [
      "反bl",
      "反耽美",
      "耽改剧",
      "耽美",
      "腐文化",
      "抵制耽美",
      "反对耽改",
      "耽美整改",
    ],
  },
  // 10 个默认分类的释义（与前端 DOMAINS / 服务端 DEFAULT_DOMAINS 对应）。
  // 这些是【宽口径】的分类释义，用于让 matchTodayTopics / tagTopicsByDomains 按用户给定的
  // 定义打标签，而非模型自行臆测。注意：这些释义【不】要求极窄判定，默认从宽、优先召回。
  {
    test: /^情感两性$/,
    note: "亲密关系、恋爱、婚姻、夫妻相处、伴侣矛盾、婆媳、家庭情感纠纷、情绪感受、男女相处心理等，凡涉及两性情感与亲密关系的话题都算。",
  },
  {
    test: /^职场成长$/,
    note: "职场工作、上下级/同事关系、求职跳槽、职业技能、个人成长、副业、职场心理等，凡涉及工作与职业发展的话题都算。",
  },
  {
    test: /^财经理财$/,
    note: "个人/家庭收支、储蓄理财、投资、消费观念、债务、赚钱思路、商业常识、金钱观念等，凡涉及钱与财务的话题都算。",
  },
  {
    test: /^健康养生$/,
    note: "身体保健、日常养生、心理健康科普、生活作息、基础身心调理（不含诊疗处方）等，凡涉及健康与养生的话题都算。",
  },
  {
    test: /^育儿教育$/,
    note: "孩子养育、家庭教育、亲子关系、学校教育、学习方法、青少年成长等，凡涉及养育与教育的话题都算。",
  },
  {
    test: /^社会热点$/,
    note: "社会公共事件、人性观察、城市生活现象、地域话题、海外奇闻、大众讨论的公共议题等，凡属大众关注的社会性话题都算。",
  },
  {
    test: /^历史文化$/,
    note: "历史故事、传统文化、民俗、人文典故、文学艺术等，凡涉及历史与人文的话题都算。",
  },
  {
    test: /^影视娱乐$/,
    note: "影视解说点评、综艺、明星八卦、文娱趣事、短视频梗、娱乐热点等，凡涉及影视与娱乐的话题都算。",
  },
  {
    test: /^科技互联网$/,
    note: "数码产品、互联网行业、网络现象、新技术科普、软件网络等，凡涉及科技与互联网的话题都算。",
  },
  {
    test: /^法制普法$/,
    note: "法律条文科普、案例解读、维权常识、法律风险提示、纠纷法律层面规定解读等，凡从法律角度讨论的话题都算。",
  },
];

// 关键词展开（通用）：任何领域——尤其是用户自定义领域——都用 LLM 把「领域名称 + 释义」
// 拆解成一组"人们在真实标题里会用"的中文搜索词，用于近30天兜底检索。
// 只填了名称就只基于名称展开；填了释义就结合释义展开。结果按 name|note 缓存，避免同一请求内重复调用。
const kwCache = new Map<string, string[]>();
async function expandDomainKeywords(name: string, note = ""): Promise<string[]> {
  const key = `${name.trim()}|${note.trim()}`;
  if (kwCache.has(key)) return kwCache.get(key)!;
  const prompt = `你是中文搜索关键词扩展助手。用户的创作领域是「${name.trim()}」${
    note.trim() ? `，其释义是：${note.trim()}` : ""
  }。
请把这个领域展开成 6-10 个"人们在真实新闻/文章标题里会实际使用"的中文搜索关键词，用于检索该领域近期的相关内容。
要求：
- 每个关键词是一个独立的短词或词组（以 1-6 个汉字为主），【不要】用空格把多个词拼在一起（搜索引擎会按 AND 处理，导致几乎搜不到）。
- 覆盖该领域的近义说法、相关现象、典型事件类型。例如领域「反bl」可展开为：反耽美、耽改剧、耽美、腐文化、抵制耽美、反对耽改、耽美整改。
- 只返回一个 JSON 字符串数组，不要任何解释或多余文字。例如：["反耽美","耽改剧","耽美"]`;
  let arr: string[] = [];
  try {
    const res: string = await callLLM([{ role: "user", content: prompt }], false);
    const m = res.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  } catch {}
  arr = (Array.isArray(arr) ? arr : [])
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => x.trim());
  kwCache.set(key, arr);
  return arr;
}

// 相关性过滤：领域词常是有歧义的缩写/自造词（如「bg」既是"男女cp"又是地球科学期刊/国家代码），
// 直接检索会混入大量【不符原意】的结果。这里用领域的准确含义（用户释义优先，否则内置词表 note）
// 逐条判断候选标题是否真的符合，剔除明显跑题的。没有可比对的精确含义时不过滤。
async function filterByRelevance(
  name: string,
  note: string,
  items: { title: string; url: string; source: string }[]
): Promise<{ title: string; url: string; source: string }[]> {
  if (items.length === 0) return items;
  const meaning =
    note.trim() ||
    (DOMAIN_GLOSSARY.find((g) => g.test.test(name))?.note || "").trim();
  if (!meaning) return items; // 没有精确含义可比对，不做过滤
  const list = items.map((it, i) => `${i}. ${it.title}`).join("\n");
  const prompt = `领域「${name.trim()}」的准确含义是：${meaning}
下面是一批候选内容的标题，请逐条判断它是否【确实符合】上述含义。
明显不符原意的必须剔除——例如同名缩写的其它意思、无关的学科/期刊/机构/国家代码、纯词义解释/百科词条等。只要拿不准是否真的在讲这个含义，就当作不符合。
只返回一个 JSON 数组，元素是【符合】条目的序号（整数），例如 [0,2,3]；若全部不符合就返回 []。不要任何解释。

${list}`;
  try {
    const res: string = await callLLM([{ role: "user", content: prompt }], false);
    const m = res.match(/\[[\s\S]*\]/);
    if (!m) return items;
    const keep = new Set<number>(
      (JSON.parse(m[0]) as unknown[]).filter((n): n is number => Number.isInteger(n))
    );
    return items.filter((_, i) => keep.has(i));
  } catch {
    return items;
  }
}

// 今日热点·确定性领域筛选的核心判断：对某个领域，用「领域名 + 释义/意图」把当日全部热点整体过一遍，
// 逐条判断是否与该领域【沾边/相关】。判据【默认从宽、优先召回】：只要实质沾边就保留，拿不准也保留，
// 只剔除完全无关的——这是修复用户反馈"明明有很多女性主义/女性成长相关热点却说没有"的关键（旧版
// "实质性触及 + 拿不准就剔除"过严，把大量沾边热点漏掉）。唯一例外：当领域释义【明确要求极窄判定】
// （如反bl 词表 note 里写死"判定要极窄"）时才转为从严，避免字面撞词滥筛。返回命中条目的下标集合；
// 异常/无法判断时返回空集合（该领域按当日0命中处理，交由上层触发近30天兜底）。
async function matchTodayTopics(
  name: string,
  meaning: string,
  items: { platform: string; title: string }[]
): Promise<Set<number>> {
  if (items.length === 0) return new Set();
  const list = items.map((it, i) => `${i}. ${it.title}`).join("\n");
  const meaningLine = meaning.trim()
    ? `领域「${name.trim()}」的准确含义是：${meaning.trim()}`
    : `领域「${name.trim()}」（没有额外释义，请按这个领域名本身的常识含义，理解它真正关心的主题与意图）`;
  const prompt = `${meaningLine}
下面是今日各平台实时热榜的标题，请把它们【整体过一遍】，逐条判断它是否和这个领域【沾边/相关】。
判断原则（默认从宽，优先召回）：
- 先理解这个领域真正关心的主题和意图，再看每条热点是否【触及或沾边】这个主题——可以是具体事件、现象、争议、相关人群、相关行业，不必字面出现领域词，也不必是该领域最典型最狭义的话题。
- 【沾边就保留】：只要一条热点和这个领域有那么一点实质关系（哪怕是边缘、间接、只涉及其中一个侧面），就算相关，应保留。例如领域是"女性主义/女性成长"，那么涉及女性权益、性别议题、女性处境、婚恋家庭中的女性、职场性别、女性题材影视、知名女性的遭遇/争议等，全部算相关。
- 【宁可多留，不要漏】：拿不准这条是否算的时候，【保留】而不是剔除。
- 只有和这个领域【完全无关、八竿子打不着】的才剔除（例如领域"女性主义"里的芯片发布、球赛比分、天气）。
- 例外——仅当上面的领域释义【明确要求极窄判定】（如"判定要极窄，只有核心话题就是该题材本身时才算"）时，才改为从严：这种情况下只是字面撞词但主题无关的必须剔除。
只返回一个 JSON 数组，元素是【相关】条目的序号（整数），例如 [0,3,5]；都不相关就返回 []。不要任何解释。

${list}`;
  try {
    const res: string = await callLLM([{ role: "user", content: prompt }], false);
    const m = res.match(/\[[\s\S]*\]/);
    if (!m) return new Set();
    return new Set<number>(
      (JSON.parse(m[0]) as unknown[]).filter((n): n is number => Number.isInteger(n))
    );
  } catch {
    return new Set();
  }
}

// 兜底发现：把领域词拆解成一组相关检索词（原始词 + 内置词表 + LLM 通用展开），逐个跑 SearXNG 聚合去重。
// ⚠️ SearXNG 的 time_range 过滤很激进：很多引擎不返回日期，会被 time_range 直接过滤成 0 条——
// 这正是"一个月都没有返回结果"的根因。所以这里【渐进放宽】：近一个月 → 近一年 → 不限时间，
// 只要总量还不够就继续放宽，保证能拿到相关内容。
async function findRecentByDomain(
  domain: string,
  limit = 12,
  note = ""
): Promise<{ title: string; url: string; source: string }[]> {
  const d = domain.trim();
  if (!d) return [];
  const hit = DOMAIN_GLOSSARY.find((g) => g.test.test(d));
  // 原始领域词（如"反bl"）本身之前就能搜到很多结果，必须始终保留并优先检索。
  // 再补上：内置词表的相关宽词（若命中）+ LLM 基于名称/释义的通用展开。去重。
  // 内置词表已充分覆盖且用户没填释义时，跳过 LLM 展开以省开销；否则一律做通用展开。
  // 描述性中文短语（如「bg与bl大战」「原生家庭」「女性成长」）本身就是精准的检索短语，
  // 直接搜原短语就能命中真正在讨论该话题的内容。此前对这类领域也做通用关键词展开，
  // 展开出的宽泛单词（如「耽美」「bl」「小说」）会把大量跑题的小说/词条 spam 冲进结果，
  // 正是用户反馈"检索内容和原意差别很大、以前好现在不行"的根因（回归）。
  // 因此：无释义的描述性中文短语【只搜原短语】，不再做通用展开，恢复此前的干净检索效果。
  // （填了释义的、命中内置词表的、或纯拉丁缩写的窄领域，仍照常展开——它们确实需要。）
  const isDescriptivePhrase =
    /[\u4e00-\u9fff]/.test(d) && d.replace(/\s/g, "").length >= 4;
  let expanded: string[] = [];
  if ((!hit || note.trim()) && !(isDescriptivePhrase && !note.trim())) {
    expanded = await expandDomainKeywords(d, note);
  }
  // 原始领域词只有在"自身就有明确检索意义"时才直接搜：无释义时照搜；有释义但原始词是纯拉丁短缩写
  // （如「bg」「bl」）时，直接搜会命中大量同名歧义内容（期刊/国家代码…），所以【不搜原始词】，
  // 改用展开词。含中文的领域词（如「反bl」）语义明确，仍保留原始词优先搜。
  const rawIsMeaningful = !note.trim() || /[\u4e00-\u9fff]/.test(d);
  let queries = Array.from(
    new Set([...(rawIsMeaningful ? [d] : []), ...(hit?.queries || []), ...expanded])
  );
  if (queries.length === 0) queries = [d]; // 兜底：展开失败也至少搜原始词

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
  // 剔除明显不符领域原意的结果（如「bg=男女cp」误命中地球科学期刊 BG、国家代码等）
  const relevant = await filterByRelevance(d, note, out);
  return relevant.slice(0, limit);
}

// 把近30天兜底结果直接拼进最终回复正文（不再用气泡框）。
// 条目按"序号. 来源｜标题"格式输出，和今日热点列表同构，
// 前端 renderAssistantContent 会自动给每条挂"查看详情"按钮。
function appendRecentFallback(
  content: string,
  fb: {
    domain: string;
    items: { title: string; url: string; source: string }[];
  } | null
): string {
  if (!fb || !fb.items || fb.items.length === 0) return content;
  const domainLabel = fb.domain || "该领域";
  const lines = fb.items.map((it, i) => {
    const src = (it.source || "").trim();
    const title = (it.title || "").trim();
    return `${i + 1}. ${src ? `${src}｜` : ""}${title}`;
  });
  const block =
    `\n\n---\n📌 今日各平台实时热榜暂无与「${domainLabel}」直接相关的热点，` +
    `以下是近30天内检索到的 ${fb.items.length} 条相关内容（非今日实时热榜，仅供参考）：\n\n` +
    lines.join("\n");
  return (content || "").trimEnd() + block;
}

// 未选领域时给热点打「分类小标签」用的默认分类集合（需与前端 page.tsx 的 DOMAINS 保持一致）。
// 未选领域时不做筛选、全部展示，只按这组通用分类给每条热点挂标签，故用固定的默认集而非用户自建领域，
// 既能保证标签口径统一、又把 LLM 判定次数限制在这组之内。
const DEFAULT_DOMAINS = [
  "情感两性",
  "职场成长",
  "财经理财",
  "健康养生",
  "育儿教育",
  "社会热点",
  "历史文化",
  "影视娱乐",
  "科技互联网",
  "法制普法",
];

// 用「逐个领域并行做服务端语义判断（matchTodayTopics）」给今日热点打领域标签，
// 返回 下标 -> 命中的领域标签集合。renderDomainFilteredHot（只留命中项）与
// renderAllPlatformsHot（全部保留、给每条挂分类小标签）共用这套判定，保证标签口径一致。
async function tagTopicsByDomains(
  all: { platform: string; title: string }[],
  domainList: string[],
  userGlossary: Record<string, string>
): Promise<Map<number, string[]>> {
  const tagsByIndex = new Map<number, string[]>();
  if (all.length === 0 || domainList.length === 0) return tagsByIndex;
  const results = await Promise.all(
    domainList.map(async (d) => {
      const meaning =
        (userGlossary[d] || "").trim() ||
        (DOMAIN_GLOSSARY.find((g) => g.test.test(d))?.note || "").trim();
      const hit = await matchTodayTopics(d, meaning, all);
      return { d, hit };
    })
  );
  for (const { d, hit } of results) {
    for (const idx of hit) {
      const arr = tagsByIndex.get(idx) || [];
      arr.push(d);
      tagsByIndex.set(idx, arr);
    }
  }
  return tagsByIndex;
}

// 未选领域时给热点打「分类小标签」：只标每条【最核心的 1-3 个领域】，不再"沾边就挂"。
// 与筛选路径（renderDomainFilteredHot 用的 tagTopicsByDomains/matchTodayTopics 从宽召回、宁多勿漏）
// 目标相反——那边要尽量不漏，这边要清爽好读、有区分度。用户反馈"一条热点被挂了七八个领域、
// 根本没涉及这么多"，根因就是拿从宽召回的口径来做展示标签。这里改成【逐条选主领域】：
// 一次性把全部热点连同领域清单（含释义）交给 LLM，让它为每条只挑最贴切的 1-3 个领域，
// 谁都不核心相关就不挂。相比逐领域并行判定（N 个领域 = N 次调用），这里是单次批量调用，更省。
async function tagTopicsCoreDomains(
  all: { platform: string; title: string }[],
  domainList: string[],
  userGlossary: Record<string, string>
): Promise<Map<number, string[]>> {
  const tagsByIndex = new Map<number, string[]>();
  if (all.length === 0 || domainList.length === 0) return tagsByIndex;
  const glossaryLines = domainList
    .map((d) => {
      const meaning =
        (userGlossary[d] || "").trim() ||
        (DOMAIN_GLOSSARY.find((g) => g.test.test(d))?.note || "").trim();
      return meaning ? `- ${d}：${meaning}` : `- ${d}`;
    })
    .join("\n");
  const list = all.map((it, i) => `${i}. ${it.title}`).join("\n");
  const prompt = `下面有一份领域清单（含含义）和一批今日热点标题。请为【每一条】热点，从领域清单里挑出它【最核心、最贴切的 1-3 个领域】。
判定原则（宁缺毋滥，只标主领域）：
- 只标这条热点真正【主要在讲】的领域；不要因为"沾一点边、间接相关"就挂上，那样标签会糊成一片、失去区分度。
- 每条最多 3 个领域，通常 1 个就够；只有当一条热点确实【横跨】多个领域时才给 2 或 3 个。
- 一条热点若和清单里任何领域都谈不上核心相关，就不给它任何领域（该序号返回空数组或省略）。
- 领域名必须【原样】来自下面的清单，不得自造、改写或合并。
领域清单：
${glossaryLines}

今日热点：
${list}

只返回一个 JSON 对象，key 是热点序号（字符串），value 是该条最核心的领域名数组，例如 {"0":["科技互联网"],"3":["社会热点","法制普法"]}；谁都不贴切的序号可省略或给空数组。不要任何解释。`;
  try {
    const res: string = await callLLM([{ role: "user", content: prompt }], false);
    const m = res.match(/\{[\s\S]*\}/);
    if (!m) return tagsByIndex;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const allow = new Set(domainList);
    for (const [k, v] of Object.entries(obj)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= all.length) continue;
      if (!Array.isArray(v)) continue;
      const tags = (v as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => allow.has(s))
        .slice(0, 3);
      if (tags.length) tagsByIndex.set(idx, tags);
    }
  } catch {
    return tagsByIndex;
  }
  return tagsByIndex;
}

// 确定性渲染"未选领域"时的全量热榜（根治"没选领域却还按历史领域筛选"）：
// 提示词/系统提醒都试过，模型仍会沿用对话历史里的旧领域锁定去过滤。既然未选领域时用户要的
// 就是"每个榜前 N 条、不筛选"，那就【完全绕开模型正文】，直接用本轮 fetch_hot_topics 抓到的
// 原始数据在服务端拼装，保证 100% 确定：抓了哪些平台就出哪些平台，各取热度前 N 条，不做任何领域过滤。
// 在"不筛选"的前提下，额外用 DEFAULT_DOMAINS 给每条热点挂上分类小标签（tagTopicsCoreDomains，
// 只标最核心的 1-3 个领域），让未指定领域时也能一眼看出每条属于哪个分类；某条谁都不核心相关就不挂标签。
async function renderAllPlatformsHot(
  fetchedByPlatform: Map<string, any[]>,
  domainUniverse: string[],
  userGlossary: Record<string, string>,
  perPlatform = 20
): Promise<string> {
  // 先按平台切片、摊平成全局有序列表，保证打标签用的下标与渲染顺序严格对齐。
  const perPlatformTitles: { platform: string; titles: string[] }[] = [];
  const all: { platform: string; title: string }[] = [];
  for (const [platform, topics] of fetchedByPlatform) {
    if (!Array.isArray(topics) || topics.length === 0) continue;
    const titles = topics
      .slice(0, perPlatform)
      .map((t: any) => (t?.title || t?.word || t?.name || "").toString().trim())
      .filter(Boolean);
    if (titles.length === 0) continue;
    perPlatformTitles.push({ platform, titles });
    for (const title of titles) all.push({ platform, title });
  }
  if (all.length === 0) return "";

  // 展示标签只标每条最核心的 1-3 个领域（逐条选主领域），避免"沾边就挂"糊成一片。
  const tagsByIndex = await tagTopicsCoreDomains(all, domainUniverse, userGlossary);

  const blocks: string[] = [];
  let gi = 0;
  for (const { platform, titles } of perPlatformTitles) {
    const lines = titles.map((title, i) => {
      const tags = tagsByIndex.get(gi);
      gi++;
      const tagStr =
        tags && tags.length ? " " + tags.map((t) => `【${t}】`).join("") : "";
      return `${i + 1}. ${title}${tagStr}`;
    });
    blocks.push(`🔥 ${platform} 今日热榜\n${lines.join("\n")}`);
  }
  return (
    `已从各平台抓取今日实时热榜（未指定领域，按各平台热度展示前 ${perPlatform} 条，不做领域筛选，仅按分类打标签）：\n\n` +
    blocks.join("\n\n") +
    `\n\n如需只看某个领域，在顶部「领域」里选择后再让我抓一次即可。`
  );
}

// 未选领域时的【确定性兜底抓取】：不依赖模型是否调用 fetch_hot_topics。
// 模型有时不抓新榜，而是直接用对话历史里的旧领域回复（甚至调 search_recent_topics_by_domain
// 拉旧领域的近30天内容），导致 renderAllPlatformsHot 因 fetchedByPlatform 为空而被绕过——
// 这就是"没选领域却按旧领域乱筛/漏垃圾"的根因。这里在服务端按用户当前选中的平台直接抓，
// 保证"没选领域 → 出各平台前20条"这条铁律 100% 生效，与模型是否听话无关。
async function fetchPlatformsHot(
  platforms: string[]
): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  const list =
    Array.isArray(platforms) && platforms.length
      ? platforms
      : Object.keys(PLATFORM_FETCHERS);
  await Promise.all(
    list.map(async (p) => {
      const name = (p || "").toString().trim();
      const fetcher = PLATFORM_FETCHERS[name];
      if (!fetcher) return;
      try {
        const arr = await fetcher();
        if (Array.isArray(arr) && arr.length > 0) map.set(name, arr);
      } catch {}
    })
  );
  return map;
}

// 构建「热点标题 → 原文链接」映射，供前端点「查看详情」时把这条热点的原报道 url 一并发给
// /api/detail，让详情接口能把这条主报道无条件置顶为核心来源。key 用与渲染完全一致的标题
// （t?.title || t?.word || t?.name 去空白），保证前端 extractTopic 拿到的标题能命中。
function buildTopicUrlMap(
  fetchedByPlatform: Map<string, any[]>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [, topics] of fetchedByPlatform) {
    if (!Array.isArray(topics)) continue;
    for (const t of topics) {
      const title = (t?.title || t?.word || t?.name || "").toString().trim();
      const url = (t?.url || t?.link || "").toString().trim();
      if (title && url && !map[title]) map[title] = url;
    }
  }
  return map;
}

// 确定性渲染"已锁定领域"时的今日热点（根治 LLM 提示词自相矛盾导致的漏筛/滥筛）：
// 用户反馈今日筛选出现两个极端——释义窄的「反bl」混进大量无关内容、释义完整的「女性主义」
// 反而漏掉当日明显相关的热点（如"女厕疑似出现摄像头"）。根因是今日筛选完全由 LLM 提示词驱动，
// 而提示词里"沾边就算/宁可多留"与"务必按释义判断、不要臆测"互相打架。这里【完全绕开模型正文】：
// 对本轮抓到的当日全量热榜，逐个领域用其释义/意图做服务端语义相关性判断（matchTodayTopics），
// 命中的才保留并打该领域标签；不相关的直接不进列表。输出格式与前端约定严格一致
// （"序号. 平台｜标题 【标签1】【标签2】"），前端 renderAssistantContent 据此挂"查看详情"、渲染胶囊。
// 某领域当日 0 命中时，其标签不会出现在正文里，交由 finalizeFallback 自动触发近30天兜底。
async function renderDomainFilteredHot(
  fetchedByPlatform: Map<string, any[]>,
  domainList: string[],
  userGlossary: Record<string, string>
): Promise<string> {
  // 摊平当日全部热点为 {platform, title}，保留平台内热度顺序、跨平台按抓取顺序拼接。
  const all: { platform: string; title: string }[] = [];
  for (const [platform, topics] of fetchedByPlatform) {
    if (!Array.isArray(topics)) continue;
    for (const t of topics) {
      const title = (t?.title || t?.word || t?.name || "").toString().trim();
      if (title) all.push({ platform, title });
    }
  }
  if (all.length === 0) return "";

  // 逐个领域并行判断命中，得到 下标 -> 命中领域标签集合。
  const tagsByIndex = await tagTopicsByDomains(all, domainList, userGlossary);

  // 汇总输出：只输出至少命中一个领域的热点，保持原始顺序，顺序编号。
  const lines: string[] = [];
  let n = 1;
  all.forEach((it, idx) => {
    const tags = tagsByIndex.get(idx);
    if (!tags || tags.length === 0) return;
    const tagStr = tags.map((t) => `【${t}】`).join("");
    lines.push(`${n}. ${it.platform}｜${it.title} ${tagStr}`);
    n++;
  });
  // 全部领域今日都 0 命中 → 返回空正文，让上层用一句说明 + finalizeFallback 走近30天兜底。
  if (lines.length === 0) return "";
  const header = `已从各平台抓取今日实时热榜，并按所选领域（${domainList.join(
    " / "
  )}）筛选出以下相关热点（按各平台热度排列）：`;
  return `${header}\n\n${lines.join("\n")}`;
}

// 确定性领域白名单强制（根治"切换领域后仍返回旧领域"）：
// 模型常沿用对话历史里的旧领域集合，把不在当前所选清单里的领域内容也列出来；提示词约束不可靠。
// 这里在服务端对模型正文做确定性过滤（不依赖模型是否听话）：
// - 带序号的条目行若【只】打了不在当前所选集合里的领域标签 → 整行删除；
// - 保留的行里，属于"非当前所选"的多余【标签】一并去掉，只留当前所选的；
// - "锁定领域：…"声明行按当前所选集合重写；
// - 仅提及"非当前所选"领域的说明句（如"今日暂无「女性成长」相关热点"）删除。
// selected = 本次锁定的领域清单；universe = 界面上全部可选领域；offSet = universe 里未被选中的。
function enforceDomainWhitelist(
  content: string,
  selected: string[],
  universe: string[]
): string {
  if (!content || selected.length === 0) return content;
  const inSet = new Set(selected);
  const offSet = universe.filter((d) => d && !inSet.has(d));
  const splitTags = (line: string) =>
    Array.from(line.matchAll(/【([^】]+)】/g))
      .flatMap((m) => m[1].split(/[、,，/／\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);

  const lines = content.split("\n");
  const out: string[] = [];
  for (let line of lines) {
    // 1) "锁定领域：…"声明行按当前所选集合重写，避免残留旧领域名
    if (/锁定(创作)?领域/.test(line) && /[：:]/.test(line)) {
      const idx = line.search(/[：:]/);
      out.push(`${line.slice(0, idx + 1)}${selected.join(" / ")}`);
      continue;
    }
    const tags = splitTags(line);
    const isItem = /^\s*\d+[.、)]/.test(line);
    if (tags.length > 0) {
      const hasIn = tags.some((t) => inSet.has(t));
      // 带标签的条目行但不含任何"当前所选领域" → 属于旧领域/臆造领域，删除（不依赖 universe）
      if (isItem && !hasIn) continue;
      // 去掉所有"非当前所选"的多余标签（旧领域残留/臆造标签），只保留当前所选的
      if (hasIn && tags.some((t) => !inSet.has(t))) {
        line = line.replace(/【([^】]+)】/g, (_full, inner: string) => {
          const kept = inner
            .split(/[、,，/／\s]+/)
            .map((s) => s.trim())
            .filter((s) => s && inSet.has(s));
          return kept.length ? kept.map((s) => `【${s}】`).join("") : "";
        });
      }
      out.push(line);
      continue;
    }
    // 2) 无标签行：仅提及"未选领域"的说明句删除（如某平台今日暂无「未选领域」相关热点）
    if (offSet.length && !isItem) {
      const mentionsOff = offSet.some((d) => line.includes(d));
      const mentionsIn = selected.some((d) => line.includes(d));
      const looksLikeDomainNote =
        /暂无|没有|无相关|相关热点|该领域|近30天|近三十天/.test(line);
      if (mentionsOff && !mentionsIn && looksLikeDomainNote) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// 收尾兜底（多领域·确定性版）：不再依赖模型输出隐藏标记或自己调工具（多领域时都不可靠），
// 而是由【服务端逐个领域确定性判断】今日正文里到底有没有它的条目：
// 判据 = 正文里是否存在【带序号的条目行】且该行打了「【领域】」标签。
// 模型对今日热点每条都必打领域标签，而系统追加的近30天条目是"序号. 来源｜标题"无标签，不会混淆。
// 没有任何带标签条目的领域 = 今日为空 → 无条件补跑近30天拆词检索并追加
//（不再受旧 ensureNicheFallback 的"命中词表/填了释义"门槛限制，自定义窄领域如「原生家庭」「bg与bl大战」也覆盖）。
// 已有条目的领域（如「女性成长」）则跳过，不会误加兜底。
async function finalizeFallback(
  content: string,
  domain: string,
  recentFallback: {
    domain: string;
    items: { title: string; url: string; source: string }[];
  } | null,
  userGlossary: Record<string, string> = {},
  allDomains: string[] = []
): Promise<{ content: string; emptyNote: string | null }> {
  const raw = content || "";
  // 模型可能仍会输出隐藏标记：现在改为服务端确定性检测，不再依赖它，但仍要清理干净不让用户看到。
  const stripped0 = raw.replace(/\[\[NO_TODAY:[^\]]*\]\]/g, "").trimEnd();
  const domainList = domain
    ? domain
        .split(/[、，,\/\s]+/)
        .map((d) => d.trim())
        .filter(Boolean)
    : [];
  // 先做确定性领域白名单强制，剔除历史污染带来的"旧领域"内容，再判断今日兜底。
  const stripped = domainList.length
    ? enforceDomainWhitelist(stripped0, domainList, allDomains)
    : stripped0;
  let fb = domainList.length ? recentFallback : null;
  // 记录"今日无热点、且近30天也没搜到"的领域，避免模型承诺了"以下为近30天内容"却什么都没有。
  const emptyDomains: string[] = [];

  if (domainList.length) {
    // 收集正文里所有"真正的带序号条目行"，用于判断某领域今日是否真有条目。
    // ⚠️"暂无/没有/近30天"这类说明句即使被模型写成带序号或带标签，也不算今日热点，否则会误判 hasToday 而跳过兜底。
    const isNoContentDecl = (line: string) =>
      /暂无|没有|无相关|未找到|近30天|近三十天|以下为近/.test(line);
    const itemLines = stripped
      .split("\n")
      .filter((line) => /^\s*\d+[.、)]/.test(line) && !isNoContentDecl(line));
    for (const d of domainList) {
      // 该领域今日已有条目（某带序号行打了【d】标签）→ 今日有热点，跳过，不补兜底
      const hasToday = itemLines.some((line) => line.includes(`【${d}】`));
      if (hasToday) continue;
      // 该领域已经在 recentFallback 里补过（模型自己调了工具）→ 跳过
      if (fb && fb.domain.split("、").includes(d)) continue;
      const note =
        (userGlossary[d] || "").trim() ||
        DOMAIN_GLOSSARY.find((g) => g.test.test(d))?.note ||
        "";
      const items = await findRecentByDomain(d, 12, note);
      if (items.length === 0) {
        emptyDomains.push(d);
        continue;
      }
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
  }

  const result = appendRecentFallback(stripped, fb);
  if (emptyDomains.length) {
    const note =
      `近30天检索也未找到与「${emptyDomains.join("、")}」直接相关的内容，` +
      `可稍后再试或在领域设置里补充更精确的释义。`;
    // 多领域：未搜到的领域单独走一个“气泡”（与回答内容同侧、互不重叠），不塞进正文；
    // 单领域：保持原行为，直接拼进正文末尾（原来效果好的不动）。
    if (domainList.length > 1) {
      return { content: result, emptyNote: note };
    }
    return { content: `${result}\n\n（${note}）`, emptyNote: null };
  }
  return { content: result, emptyNote: null };
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
- ✅ 不做硬性剔除，沾边就算：只要一条热点和「${domain}」有那么一点关系（哪怕是边缘、间接、只是沾边），就【保留并展示】；只有和所有锁定领域【完全、彻底无关、八竿子打不着】的（例如领域「美食探店」里的选举/地缘政治/机器人），才不列出。原则是宁可多留，不要漏。
- ✅ 保留而不是删弱相关：只要沾边就留下，绝不要因为"不够典型/只是边缘相关"就把它剔除。
- ✅ 按【热度】排序：保留下来的热点，直接按各平台榜单的原始热度高低排列（热度高的在前），不要再按相关度重排，也不要加 ⭐ 之类的标记。
- ⚠️【禁止输出逐条分析过程】不要写"关键词判断""XX属于XX领域→保留""XX边缘、更偏娱乐"这类逐条判断/分析说明文字，也不要解释你为什么保留或排除某条。直接给出【结果列表】即可，不要任何前置的分析段落。
- 保留下来的每条热点，后面标注它所属的领域标签；标签只能从用户所选的领域（${domain}）里挑，不要用其它标签体系。
- ⚠️ 每个领域必须用【独立的】书名号括起来，一个领域一个【】。绝对禁止把多个领域塞进同一个【】里。错误写法：${wrongExample}；正确写法：${rightExample}（这条同时属于多个领域时才这样写）。
- ⚠️ 严禁给每条热点都打上完全相同的一组标签：用户选了多个领域时，绝大多数热点只真正属于其中【一个】领域，你要逐条独立判断，只标它确实属于的那个。如果你发现自己给几乎每一条都打了同样的标签组合，这几乎一定是判断错了，请推翻重来。比如一条只讲女性个人成长/女性权益的热点，就只标【女性成长】，与「反bl」无关时绝不能加【反bl】。
- 格式示例：1. 某条${domainList[0] || "该领域"}相关的热点 【${domainList[0] || "该领域"}】${glossaryBlock}`
    : `展示热点的输出规范（用户未锁定领域，全部展示并归类）：
- 列出各平台抓到的全部热点，按平台热度原顺序展示，不做筛选和重排。
- 每一条热点后面都要用【】标注它所属的创作领域标签，可以多标（一条热点可同时属于多个领域）；每个领域用独立的【】，不要塞进同一个【】。
- 领域标签从以下集合中选取：科技数码、职场成长、美食探店、娱乐八卦、财经理财、健康养生、教育学习、旅行出行；若都不贴合，可补充一个最贴切的自定义标签。
- 格式示例：1. 某热点标题 【职场成长】【财经理财】`;

  return `你是一个专业的自媒体热点分析 Agent。${domainHint}目标平台是：${platforms.join("、")}。
${
  domain
    ? `\n🔒【领域锁定 = 最高优先级，凌驾于用户本次说法之上】用户已在界面锁定创作领域「${domain}」。这是一个持续生效的【相关度筛子】：无论用户这次说的是"抓取热点""抓今日热点""全量热榜""原始热点"还是任何类似说法，你最终展示的内容都【必须】围绕「${domain}」组织——沾边的都保留，只有完全无关的才不列出；保留下来的按各平台原始热度从高到低排列。抓取阶段照常抓全量。【不要】把弱相关的删掉，也【不要】写逐条分析的过程文字；但也【不要】因为用户说了"抓取/全量/原始"就把和领域完全无关的内容也堆进来。\n- ⚠️【当前领域集合是唯一权威，以本条为准】本次锁定的领域【完整清单】就是：${domainList.map((d) => `「${d}」`).join("、")}，共 ${domainList.length} 个。用户随时可能在界面上增删领域，所以【对话历史里出现过的领域组合可能已经过期】。你【必须】以本条系统提示里的这份清单为准，对清单里的【每一个】领域都主动去抓取、归类、排序——包括刚新增的领域。绝对不要沿用你之前回复里用过的旧领域集合。\n- ⚠️【每次抓取都要真跑，禁止偷懒复用】只要用户要求抓取/刷新/再来一次，你就【必须】重新调用 fetch_hot_topics 并按当前完整领域清单重新排序，输出全新结果。【严禁】回复"无变化""仍是N条""数据没更新""内容重复""与其让你等待"这类话，也【严禁】直接把上一轮的列表原样再贴一遍——因为用户很可能刚改动了所选领域，"无变化"几乎一定是错的。\n- 🆕【今日完全没有沾边热点的领域，只写一句说明，剩下交给系统】对本次锁定的【每一个】领域，你都要在各平台今日实时热榜里把沾边的热点排进来并打上【领域】标签。如果某个领域【连沾边的都一条都没有】（尤其是小众/垂直领域，如「反bl」「原生家庭」「bg与bl大战」），你【只需】在正文里对该领域用一句话说明"今日各平台实时热榜暂无「该领域」相关热点，以下为近30天相关内容"，然后【就停在这里】——【不要】自己去调 search_recent_topics_by_domain、【不要】自己罗列任何近30天条目、也【不要】编造"经检索暂无""近期无引爆公共讨论的热点"之类结论草草收尾。系统会【自动检测】哪些领域今日没有任何带标签条目，并【自动为其检索近30天内容追加到回复末尾】，你自己写条目只会和系统追加的内容重复。\n`
    : `\n🔓【用户已清空所有创作领域 = 最高优先级，凌驾于对话历史之上】用户当前在界面上【没有选择任何创作领域】。这条以本条系统提示为准：无论对话历史里之前是否锁定过某个领域（例如「女性成长」或任何其它领域），那份锁定【现在已经全部失效、作废】——因为用户已经把所有领域都取消了。你【绝对不要】再按任何历史领域去筛选、剔除或重排热点，也【绝对不要】沿用上一轮回复里针对某个领域的筛选结果。\n- ✅ 你【必须】列出各平台抓到的【全部】热点，按各平台榜单原始热度顺序展示，【不做任何领域筛选、不做剔除、不加 ⭐ 相关度标记、不做重排】。\n- ✅ 每一条热点后面用【】标注它所属的创作领域标签（可多标），标签自由从常见领域集合里选取，而不是局限在任何历史锁定过的领域。\n- ⚠️ 只要用户要求抓取/刷新，你就【必须】重新调用 fetch_hot_topics 并输出全量带标签结果，【严禁】回复"无变化""与上次相同"或原样复用上一轮列表。\n`
}
你的能力：
1. fetch_hot_topics: 从微博、知乎、B站、抖音、小红书、头条、百度、什么值得买抓取实时热点
2. filter_hot_by_domain: 用 AI 判断哪些热点和用户领域相关
3. generate_video_script: 根据热点生成短视频脚本（Hook → 痛点 → 内容 → CTA）
4. search_recent_topics_by_domain: 小众/垂直领域今日实时热榜无相关热点时，检索该领域近30天内容做兜底

工作流程：
- 用户说"抓热点"时，依次调用各平台的 fetch_hot_topics${
    domain ? "；抓完后保留和锁定领域沾边的（只丢完全无关的），按各平台原始热度从高到低展示，不要写逐条分析过程" : ""
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
  domain: string,
  userGlossary: Record<string, string> = {}
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
判断标准是"核心话题是否落在该领域所属的【大类/行业/学科范围】之内"——只要落在这个大范围内，哪怕只是它的某个细分方向、子行业或具体产品（如领域「科技数码」里的手机影像、芯片、AI、生物科技、新能源车等），就【算属于】，要选进来；【不要】因为"不是该领域最狭义最典型的话题"就把它排除。真正要排除的只有核心话题与该领域【完全无关】的内容。
数量不设固定上限，有几个真正相关的就返回几个（可能只有 1-2 个，也可能 8 个以上），按相关度从高到低排序；如果一个都不相关，就返回空数组 []。
只返回 JSON 数组，每项包含 rank, title, reason(为什么属于该领域)。

热点列表：
${JSON.stringify(args.topics, null, 2)}`;
      const filterRes = await callLLM([{ role: "user", content: filterPrompt }], false);
      return filterRes;
    }
    case "generate_video_script": {
      const scriptDomain = args.domain || domain;
      // 相关性抽样（可跨领域）取最贴的 5 条，作为"结构套路"参考。
      const samples = await pickRelevantTemplates(args.topic, scriptDomain, 5, plainLLM);
      const refBlock = samples.length
        ? `\n\n以下是与该话题套路最贴的真实高播放口播爆款拆解样例（可能跨领域，重点学它们的开头钩子、结构节奏、金句话术、CTA 和情绪基调，用同样的套路来写——是仿其"套路"，不是抄其内容）：\n\n${renderTemplates(samples)}`
        : "";
      // 用相关度最高那条的原文片段补"真实语感"：只学口语措辞和节奏，不抄内容。
      const topRaw = samples[0]?.原文摘录?.trim();
      const rawBlock = topRaw
        ? `\n\n另外，这是上面最贴那条口播的真实原文片段，请只学它的口语措辞、语气和节奏语感（忽略语音转写产生的错别字），不要照抄其中的具体内容：\n「${topRaw}」`
        : "";
      const scriptPrompt = `你是爆款短视频编剧。请根据以下信息生成一个短视频脚本：

话题：${args.topic}
领域：${scriptDomain}
风格：${args.style || "口播知识分享"}

脚本结构要求：
1. 🎣 Hook（前3秒抓住注意力的开场）
2. 💢 痛点（观众的痛点/好奇心）
3. 💡 内容（核心价值输出，3-5个要点）
4. 📢 CTA（引导互动的结尾）

字数控制在300-500字，口语化，有节奏感。${refBlock}${rawBlock}`;
      const scriptRes = await callLLM([{ role: "user", content: scriptPrompt }], false);
      return scriptRes;
    }
    case "search_recent_topics_by_domain": {
      const raw = (args.domain || domain || "").toString().trim();
      if (!raw)
        return JSON.stringify({ domain: "", range: "近30天", realtime: false, items: [] });
      // 模型可能把【多个领域】一次性传进来（如"bg与bl大战、原生家庭"）。若把整串当成一个
      // 检索词，SearXNG 几乎搜不到（过窄），这正是"多领域没出兜底"的一条根因。
      // 所以在这里把领域串拆成单个领域，逐个检索再合并去重——和单领域效果一致。
      const subs = raw
        .split(/[、，,\/\s]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      const domains = subs.length ? subs : [raw];
      const merged: { title: string; url: string; source: string }[] = [];
      const seen = new Set<string>();
      for (const one of domains) {
        const note = (userGlossary[one] || "").trim();
        const items = await findRecentByDomain(one, 12, note);
        for (const it of items) {
          if (it.url && !seen.has(it.url)) {
            seen.add(it.url);
            merged.push(it);
          }
        }
      }
      return JSON.stringify(
        { domain: domains.join("、"), range: "近30天", realtime: false, items: merged },
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
    const { messages, domain, platforms, glossary, allDomains } = await req.json();
    const userGlossary: Record<string, string> =
      glossary && typeof glossary === "object" ? glossary : {};
    // 界面上全部可选领域（用于确定性剔除"未选领域"内容，根治历史污染导致的旧领域残留）
    const domainUniverse: string[] = Array.isArray(allDomains)
      ? allDomains.filter((x: unknown): x is string => typeof x === "string")
      : [];
    // 本次锁定的领域清单（唯一权威）。模型有时会用对话历史里的【旧领域】去调
    // search_recent_topics_by_domain，其近30天结果若混进回复就是"切换领域后仍返回旧领域"的
    // 一条泄漏路径（这些兜底条目无标签，enforceDomainWhitelist 也删不掉）。用它在收集处过滤。
    const currentDomainList: string[] = (typeof domain === "string" ? domain : "")
      .split(/[、，,\/\s]+/)
      .map((d: string) => d.trim())
      .filter(Boolean);

    if (!OPENAI_API_KEY) {
      return NextResponse.json({
        content: "⚠️ 服务端未配置 OPENAI_API_KEY，请联系管理员。",
        toolLogs: [],
      });
    }

    const systemMsg = {
      role: "system",
      content: buildSystemPrompt(domain, platforms, userGlossary),
    };

    let conversationMessages = [systemMsg, ...messages];
    // 领域可能刚被改名/增删，但对话历史里还留着旧领域的锁定声明、筛选结果和标签。
    // 在最后一条用户消息前插入一条“当前领域”提醒（最高时效性），强制本次结果只依据最新领域集合，
    // 避免模型沿用历史里的旧标签——即"改完标签，新跑的结果必须符合新标签"。
    if (domain) {
      const dl = domain
        .split(/[、，,\/\s]+/)
        .map((d: string) => d.trim())
        .filter(Boolean);
      const reminder = {
        role: "system",
        content: `【重要·以此为准】用户当前锁定的领域集合是：${dl
          .map((d: string) => `「${d}」`)
          .join(
            "、"
          )}，共 ${dl.length} 个。这份清单【覆盖并作废】对话历史里出现过的任何旧领域组合（用户随时可能改名/增删领域）。本次抓取、筛选、近30天兜底与打标签都【只能】依据这份最新清单逐个领域重新判断；历史消息里针对旧领域生成的“锁定领域/筛选结果/标签”一律【不得沿用】。若发现历史标签与当前清单不一致，以当前清单为准。`,
      };
      const lastUserIdx = conversationMessages
        .map((m: any) => m.role)
        .lastIndexOf("user");
      if (lastUserIdx >= 0) conversationMessages.splice(lastUserIdx, 0, reminder);
      else conversationMessages.push(reminder);
    } else {
      // 领域被清空时，对话历史里可能还留着上一轮“锁定某领域→逐条硬性过滤→带⭐相关度”的
      // 回复。模型倾向于沿用自己历史里的做法，导致明明没选领域却还在按旧领域筛选。
      // 在最后一条用户消息前插入一条最高时效性的提醒，强制本轮展示全部热点、不做任何领域筛选。
      const reminder = {
        role: "system",
        content: `【重要·以此为准】用户当前【没有选择任何创作领域】，这【覆盖并作废】对话历史里出现过的任何领域锁定（例如之前锁过的「美食探店」「科技数码」或任何领域，现在全部失效）。本轮【必须】列出各平台抓到的【全部】热点，按各平台原始热度顺序展示，【禁止】按任何历史领域做筛选、剔除、重排或添加 ⭐ 相关度标记；每条热点后面只需用【】自由标注它所属的创作领域标签即可。历史消息里针对某个锁定领域生成的“锁定领域/逐条硬性过滤/筛选结果”一律【不得沿用】。`,
      };
      const lastUserIdx = conversationMessages
        .map((m: any) => m.role)
        .lastIndexOf("user");
      if (lastUserIdx >= 0) conversationMessages.splice(lastUserIdx, 0, reminder);
      else conversationMessages.push(reminder);
    }
    const toolLogs: string[] = [];
    // 近30天兜底：小众领域今日无热点时，search_recent_topics_by_domain 的结果收集到这里，
    // 最终由 appendRecentFallback 直接拼进回复正文（不再用气泡框）。
    let recentFallback: {
      domain: string;
      items: { title: string; url: string; source: string }[];
    } | null = null;
    // 未选领域时用于确定性渲染的原始抓取结果：平台名 → 该平台热点数组（保留抓取顺序）。
    const fetchedByPlatform = new Map<string, any[]>();
    const noDomain = !(typeof domain === "string" && domain.trim());
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
        // 未选领域 → 无条件走确定性全量热榜：模型没抓就服务端补抓，杜绝其按历史领域私自筛选。
        if (noDomain) {
          const fbp =
            fetchedByPlatform.size > 0
              ? fetchedByPlatform
              : await fetchPlatformsHot(platforms);
          const deterministic = await renderAllPlatformsHot(
            fbp,
            DEFAULT_DOMAINS,
            userGlossary
          );
          if (deterministic) {
            return NextResponse.json({
              content: deterministic,
              toolLogs,
              topicUrls: buildTopicUrlMap(fbp),
            });
          }
        }
        // 已锁定领域 → 无条件走确定性领域筛选替换模型正文（根治提示词自相矛盾导致的漏筛/滥筛）：
        // 与"未选领域"同理，模型常常不抓新榜、而是沿用对话历史里的【旧领域】答复（如上一轮的
        // 「灰灰男」结果）来污染本轮，导致带旧领域内容的兜底块（无【领域】标签，enforceDomainWhitelist
        // 删不掉）泄漏。因此模型没抓就【服务端补抓】，再逐领域确定性筛选，彻底不信任模型正文。
        let baseContent = assistantMessage.content || "完成。";
        let domainFetched = fetchedByPlatform;
        if (!noDomain && currentDomainList.length) {
          domainFetched =
            fetchedByPlatform.size > 0
              ? fetchedByPlatform
              : await fetchPlatformsHot(platforms);
          const deterministic = await renderDomainFilteredHot(
            domainFetched,
            currentDomainList,
            userGlossary
          );
          baseContent =
            deterministic ||
            `今日各平台实时热榜暂无与所选领域直接相关的热点。`;
        }
        const fin = await finalizeFallback(
          baseContent,
          domain,
          recentFallback,
          userGlossary,
          domainUniverse
        );
        return NextResponse.json({
          content: fin.content,
          emptyNote: fin.emptyNote,
          toolLogs,
          topicUrls: buildTopicUrlMap(domainFetched),
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

        const result = await executeTool(fnName, fnArgs, domain, userGlossary);

        // 捕获原始抓取结果，供"未选领域"时确定性渲染全量热榜（不依赖模型正文）。
        if (fnName === "fetch_hot_topics") {
          const platform = (fnArgs.platform || "").toString().trim();
          if (platform) {
            try {
              const arr = JSON.parse(result);
              if (Array.isArray(arr) && arr.length > 0) {
                fetchedByPlatform.set(platform, arr);
              }
            } catch {}
          }
        }

        // 收集近30天兜底结果（可能针对多个小众领域被调用多次，合并去重）
        // 未选领域时【绝不收集】：模型常用对话历史里的旧领域（如已删除的「情感变现实操」）
        // 去调此工具，其结果无领域标签，enforceDomainWhitelist 删不掉，会以垃圾兜底形式泄漏给用户。
        if (!noDomain && fnName === "search_recent_topics_by_domain") {
          try {
            const parsed = JSON.parse(result);
            const dm = (parsed.domain || "").toString().trim();
            // 兜底结果的 domain 可能是【单个】也可能是模型一次传进来的【多领域串】
            //（如"bg与bl大战、原生家庭"），所以按分隔符拆开逐个比对，而不是整体精确匹配——
            // 否则多领域串永远匹配不上当前清单里的单个领域，会把本该出的兜底整块丢掉（回归）。
            const dmTokens = dm
              .split(/[、，,\/\s]+/)
              .map((s: string) => s.trim())
              .filter(Boolean);
            // 只要有【任一】token 属于当前锁定领域就接受；全都不属于（纯旧领域）才丢弃。
            // 当前清单为空、或 domain 缺失时不设限，保持原行为。
            const domainAllowed =
              currentDomainList.length === 0 ||
              dmTokens.length === 0 ||
              dmTokens.some((t: string) => currentDomainList.includes(t));
            if (
              domainAllowed &&
              Array.isArray(parsed?.items) &&
              parsed.items.length > 0
            ) {
              if (!recentFallback) recentFallback = { domain: "", items: [] };
              const seen = new Set(recentFallback.items.map((x) => x.url));
              for (const it of parsed.items) {
                if (it?.url && !seen.has(it.url)) {
                  seen.add(it.url);
                  recentFallback.items.push(it);
                }
              }
              // 记录命中的当前领域（拆成单个存），供 finalizeFallback 按领域跳过重复兜底
              const existing = recentFallback.domain
                ? recentFallback.domain.split("、")
                : [];
              const toAdd =
                dmTokens.length && currentDomainList.length
                  ? dmTokens.filter((t: string) => currentDomainList.includes(t))
                  : dmTokens.length
                    ? dmTokens
                    : dm
                      ? [dm]
                      : [];
              for (const t of toAdd) {
                if (t && !existing.includes(t)) existing.push(t);
              }
              recentFallback.domain = existing.join("、");
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
    // 未选领域 → 同样无条件走确定性全量热榜（模型没抓就服务端补抓），达到迭代上限时也不让模型自行筛选。
    if (noDomain) {
      const fbp =
        fetchedByPlatform.size > 0
          ? fetchedByPlatform
          : await fetchPlatformsHot(platforms);
      const deterministic = await renderAllPlatformsHot(
        fbp,
        DEFAULT_DOMAINS,
        userGlossary
      );
      if (deterministic) {
        return NextResponse.json({
          content: deterministic,
          toolLogs,
          topicUrls: buildTopicUrlMap(fbp),
        });
      }
    }
    // 已锁定领域 → 同样无条件走确定性领域筛选（模型没抓就服务端补抓），达到迭代上限时也不让模型自行筛选。
    if (!noDomain && currentDomainList.length) {
      const domainFetched =
        fetchedByPlatform.size > 0
          ? fetchedByPlatform
          : await fetchPlatformsHot(platforms);
      const deterministic = await renderDomainFilteredHot(
        domainFetched,
        currentDomainList,
        userGlossary
      );
      const fin = await finalizeFallback(
        deterministic || `今日各平台实时热榜暂无与所选领域直接相关的热点。`,
        domain,
        recentFallback,
        userGlossary,
        domainUniverse
      );
      return NextResponse.json({
        content: fin.content,
        emptyNote: fin.emptyNote,
        toolLogs,
        topicUrls: buildTopicUrlMap(domainFetched),
      });
    }
    conversationMessages.push({
      role: "user",
      content: "请总结以上所有工具调用的结果，给出最终回复。",
    });
    const finalMsg = await callLLM(conversationMessages, false);

    const fin = await finalizeFallback(
      finalMsg || "已完成处理。",
      domain,
      recentFallback,
      userGlossary,
      domainUniverse
    );
    return NextResponse.json({
      content: fin.content,
      emptyNote: fin.emptyNote,
      toolLogs,
      topicUrls: buildTopicUrlMap(fetchedByPlatform),
    });
  } catch (e: any) {
    return NextResponse.json(
      { content: `服务错误: ${e.message}`, toolLogs: [] },
      { status: 500 }
    );
  }
}