import { NextRequest, NextResponse } from "next/server";
import {
  ANTI_AI_RULES,
  pickRelevantTemplates,
  renderTemplateOutlines,
  renderExcerpts,
} from "../_shared/templates";
import {
  recordSourceHealth,
  type SourceHealthEntry,
} from "../../../lib/sourceHealth";
import { searxSearch, searxSearchUnion } from "../../../lib/searx";
import { crawlerSearch } from "../../../lib/crawler";
import { titleRelevant, queryPlan } from "../../../lib/relevance";
import { flashNewsSearch } from "../../../lib/flashNews";
import { fixAgeClaims } from "../../../lib/ageGuard";
import { guardQuotes } from "../../../lib/quoteGuard";
import { getLlm, LlmApiError, llmChatJson, llmErrorAction, isInternalRequest, resolveRequestLlm, setRequestLlm } from "../../../lib/llm";
import { classifyTurn, TASK_VERB_RE } from "../../../lib/intent";
import { retrieveKnowledge, retrieveVoiceCorpus, formatKnowledge, KB_CATEGORIES } from "../../../lib/rag";
import {
  classifyScriptIntent,
  OPINION_FACT_BOUNDARY,
  INFO_NARRATIVE_RULE,
  infoFactDiscipline,
  HOOK_QUOTE_RULE,
} from "../_shared/scriptIntent";

// 爆款口播模板：由 collector/analyze_scripts.py 从真实高播放口播文稿拆解而来。
// 生成脚本时按领域取样，作为"参考爆款样例"喂给模型仿写，而非套空结构。
// 读取与挑选逻辑已抽到 ../_shared/templates.ts，与 api/script 路由共用。

// 把本路由的 callLLM 适配成 _shared/templates 需要的「给 prompt、返回文本」形态。
const plainLLM = (prompt: string): Promise<string> =>
  callLLM([{ role: "user", content: prompt }], false) as Promise<string>;



// 本地 DailyHotApi 地址（需先部署，见说明）
const DAILYHOT_BASE = process.env.DAILYHOT_BASE_URL || "http://localhost:6688";

// 自建 SearXNG（部署在腾讯云 VPS）——检索实现统一在 src/lib/searx.ts（12s 超时 +
// 空结果换词重试一次 + 10min TTL 缓存防重复轰引擎）

// 自建 RSSHub（阶段2 已随 hot-web 一起部署在 VPS，端口 1200）——第二聚合层，
// 实现路径与 DailyHotApi 不同（微博走 HTML 抓取、B站走排行榜页等），本地挂掉时互为冗余。
const RSSHUB_BASE = (process.env.RSSHUB_BASE_URL || "http://localhost:1200").replace(/\/+$/, "");

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
// 检索实现已抽到 @/lib/searx 共享模块（12s 超时 + 空结果换词重试 + 10min 缓存），
// 成人/SEO 垃圾站与搜索引擎自身页过滤在共享模块里统一做（百科页保留，由权威桶保席）。
async function searxRecentSearch(
  query: string,
  limit = 12,
  timeRange: "day" | "week" | "month" | "year" | "" = "month",
  withContent = false
): Promise<{ title: string; url: string; source: string; content?: string }[]> {
  const hits = await searxSearch(query, { limit, timeRange, dropWiki: true });
  return hits.map((h) => ({
    title: h.title,
    url: h.url,
    source: hostLabel(h.url),
    ...(withContent ? { content: h.content } : {}),
  }));
}

// 三路并集检索（方案A）：短词不限时资料 + 短词近30天新帖 + 视频类目（bilibili）动态。
// 近30天兜底主链路和实体资料预取都用它——新帖优先排序、日期标签（published）由共享层完成。
type UnionHit = {
  title: string;
  url: string;
  source: string;
  published?: string;
  content?: string;
};
// 权威信源域名（2026-09 数据源评测）：央媒/政府/主流财经媒体。这些站点的老报道常无
// publishedDate，会在"纯新鲜度排序"里沉底，被带日期的贴吧新帖挤出前 10——降准召回里
// gov.cn/新华网被"贴吧·nba2kol"挤掉就是这个机理。权威组显式托底优先，不受新鲜度压制。
const AUTHORITY_HOST_RE =
  /(^|\.)(gov\.cn|news\.cn|xinhuanet\.com|xinhuanet\.net|people\.com\.cn|people\.cn|cctv\.cn|cnr\.cn|gmw\.cn|chinanews\.com|china\.com\.cn|ce\.cn|thepaper\.cn|caixin\.com|cls\.cn|wallstreetcn\.com|gelonghui\.com|youth\.cn|cyol\.com|legaldaily\.com\.cn|bjnews\.com\.cn|bjd\.com\.cn|zjol\.com\.cn|southcn\.com|rednet\.cn|jfdaili\.com|workercn\.cn|guancha\.cn|yicai\.com|stcn\.com|21jingji\.com|cnstock\.com|cs\.com\.cn|pbc\.gov\.cn|baike\.baidu\.com|wikipedia\.org|baike\.so\.com)$/i;
// 百科类域名子集：放开百科过滤后需要做相关性复核（词典页也是 baike 域名）
const ENCYCLOPEDIA_HOST_RE = /(^|\.)(baike\.baidu\.com|baike\.so\.com|wikipedia\.org)$/i;
// 词典/字典/翻译站：热点问答场景下的纯噪声（"董"拼音页、city 翻译页）。
// 单独成桶最后兜底——标题与主体词相关时豁免（如 britannica 讲正经概念），
// 正常结果够 8 条时不相关的词典页整条丢弃，不够也最多留 1 条凑数。
const DICT_SITE_HOST_RE =
  /(^|\.)(hgcha\.com|hanyuguoxue\.com|iciba\.com|wiktionary\.org|dictionary\.cambridge\.org|collinsdictionary\.com|britannica\.com|zdic\.net|chazidian\.com|shidianguji\.com|chagushici\.com|dict\.cn|dict\.youdao\.com|zidian\.[a-z.]+)$/i;
// 自建爬虫/直连社区（微博/贴吧/知乎/虎扑/豆瓣）来源标签前缀——用于社区帖配额
const CRAWLER_SOURCE_RE = /^(微博|贴吧|知乎|虎扑|豆瓣)/;

async function searxUnionSearch(
  query: string,
  limit = 12,
  withContent = false
): Promise<UnionHit[]> {
  // 统一拆解：门控全部用剥壳短语 + 语境词（"cs中的研发芯片是什么梗"→"cs 研发芯片"，
  // 半导体"研发费用"页只撞"研发"一个泛词、语境词 cs 不在场 → 沉 offTopic 桶）。
  // 检索调用仍传原始 query——searx/crawler 入口内部已统一剥壳，且要保留原问句供题型判定。
  const plan = queryPlan(query);
  // 方案C接入（2026-09）：三路并集之上再并行一路自建爬虫（微博/贴吧第一手帖子）。
  // 爬虫是增强源：服务挂了/超时/为空一律静默降级为空数组（crawlerSearch 内部已兜底），
  // 绝不影响 searx 主链路；健康明细见 /api/health 的"自建爬虫"。
  const [hits, crawlerHits] = await Promise.all([
    searxSearchUnion(query, { limit, dropWiki: true }),
    crawlerSearch(query, { limit: 6 }),
  ]);
  const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
  const isFresh = (h: UnionHit) =>
    !!h.published && new Date(h.published).getTime() >= yearAgo;
  const seen = new Set<string>();
  const toHit = (
    h: { title: string; url: string; source?: string; published?: string; content?: string },
    source: string
  ): UnionHit => ({
    title: h.title,
    url: h.url,
    source,
    ...(h.published ? { published: h.published } : {}),
    ...(withContent && h.content ? { content: h.content } : {}),
  });
  // 分桶（2026-09 排序修正）：
  //   authority  权威媒体/政府网页（最高优先，不受新鲜度压制，封顶 6 条避免垄断）
  //   freshWeb   近一年带日期的普通网页
  //   freshComm  近一年带日期的社区帖（爬虫）
  //   restWeb    其他网页
  //   restComm   其他社区帖
  // 社区帖（freshComm+restComm）硬配额 ≤40%：保留民间视角，但绝不允许像旧逻辑那样
  // 无条件置顶 6 条把网页结果全部截断。
  const buckets: Record<string, UnionHit[]> = {
    authority: [],
    freshWeb: [],
    freshComm: [],
    restWeb: [],
    restComm: [],
    // 标题与主体词零词面命中的引擎串味（降准→"中医脉搏"、Cursor→"VFP cursor1"、
    // city不city→"拼多多city 曼城"）：不删除，沉到倒数第二桶，正常结果够就轮不到它。
    // 只卡 searx 路——自建爬虫路在 crawlerSearch 内部已做过同口径门控。
    offTopic: [],
    dict: [],
  };
  const place = (it: UnionHit) => {
    if (!it.url || seen.has(it.url)) return;
    seen.add(it.url);
    let host = "";
    try {
      host = new URL(it.url).hostname;
    } catch {}
    const comm = CRAWLER_SOURCE_RE.test(it.source);
    // 百科类权威保席的相关性复核（2026-09）：放开百科过滤后，单字/词义词典页
    //（"董"/"降"/"什么"/"广州市"）也顶着 baike 域名占掉 6 个保席槽。门控用剥掉虚词的
    // 裸主体词（"什么是降准"→"降准"），整句里的"是降"这类半虚词 bigram 会造成误杀。
    const subj = plan.main;
    const isAuth =
      AUTHORITY_HOST_RE.test(host) &&
      (!ENCYCLOPEDIA_HOST_RE.test(host) ||
        titleRelevant(it.title, subj, plan.context));
    const key = isAuth
      ? "authority"
      : DICT_SITE_HOST_RE.test(host) &&
          !titleRelevant(it.title, subj, plan.context)
        ? "dict"
        : // searx 路结果（非自建爬虫）标题与主体词零命中 → 引擎串味桶，沉底不删除
          !comm && !titleRelevant(it.title, subj, plan.context)
          ? "offTopic"
          : comm
            ? isFresh(it)
              ? "freshComm"
              : "restComm"
            : isFresh(it)
              ? "freshWeb"
              : "restWeb";
    buckets[key].push(it);
  };
  for (const h of hits)
    place(toHit(h, hostLabel(h.url)));
  for (const h of crawlerHits) place(toHit(h, h.source));
  // 桶内顺序：权威/网页保持引擎合并序（searx 内部已新帖优先）；社区帖按日期新→旧
  buckets.freshComm.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  buckets.restComm.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  const commQuota = Math.max(2, Math.floor(limit * 0.4));
  const merged: UnionHit[] = [];
  let commUsed = 0;
  // free=true 的桶不受 40% 社区配额限制（民间话语题型下社区帖是主菜不是配菜）
  const take = (arr: UnionHit[], max?: number, free = false) => {
    let n = 0;
    for (const it of arr) {
      if (merged.length >= limit) return;
      const isComm = CRAWLER_SOURCE_RE.test(it.source);
      if (isComm && !free && commUsed >= commQuota) continue; // 社区配额满，跳过等网页补位
      merged.push(it);
      if (isComm) commUsed++;
      n++;
      if (max !== undefined && n >= max) return;
    }
  };
  if (plan.folkAsk) {
    // 用户自己写明问的是民间话语（梗/黑话/名场面/外号…）：社区讨论帖前置，
    // 权威/网页退居其后，桶顺序调整而已，任何结果都不删除。
    take(buckets.freshComm, 4, true);
    take(buckets.restComm, 3, true);
    take(buckets.authority, 4);
    take(buckets.freshWeb);
    take(buckets.restWeb);
    take(buckets.offTopic, 1);
    take(buckets.dict);
  } else {
    take(buckets.authority, 6);
    take(buckets.freshWeb);
    take(buckets.freshComm);
    take(buckets.restWeb);
    take(buckets.restComm); // 配额仍有余量时才会再进社区帖
    take(buckets.offTopic); // 引擎串味帖：正常结果不够凑数时才出现
    take(buckets.dict); // 词典/翻译站最后凑数
  }
  // 正常来源够 8 条就不凑词典噪声；实在不够也最多留 1 条，且排在最后
  const hostOfMerged = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  };
  if (merged.filter((it) => !DICT_SITE_HOST_RE.test(hostOfMerged(it.url))).length >= 8)
    return merged.filter((it) => !DICT_SITE_HOST_RE.test(hostOfMerged(it.url)));
  let dictKept = 0;
  return merged.filter(
    (it) =>
      !DICT_SITE_HOST_RE.test(hostOfMerged(it.url)) || dictKept++ < 1
  );
}

// 通用：按优先级依次尝试多个数据源。
// 阶段3 故障可视化：不再静默吞错——每个源失败都会 console.warn 记录原因、
// 写入 SOURCE_HEALTH（/api/health 读取），并把失败明细拼进最终错误文案，
// 前端渲染时平台行会显示"⚠️ 哪个源挂了、为什么"。
async function tryFetchSources(
  sources: (() => Promise<any[]>)[],
  platformKey: string,
  platformMsg: string,
  sourceNames: string[] = []
): Promise<any[]> {
  const health: SourceHealthEntry[] = [];
  const failures: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const name = sourceNames[i] || `源${i + 1}`;
    try {
      const result = await sources[i]();
      if (result && result.length > 0 && !result[0]?.error) {
        health.push({ source: name, ok: true, error: "", at: Date.now() });
        recordSourceHealth(platformKey, health);
        return result;
      }
      const reason = result?.[0]?.error || "返回空列表";
      failures.push(`${name}: ${reason}`);
      health.push({ source: name, ok: false, error: reason, at: Date.now() });
    } catch (e: any) {
      const reason = e?.message || "请求异常";
      failures.push(`${name}: ${reason}`);
      health.push({ source: name, ok: false, error: reason, at: Date.now() });
    }
  }
  recordSourceHealth(platformKey, health);
  console.warn(
    `[source] ${platformKey} 全部 ${sources.length} 个数据源失败: ${failures.join("；")}`
  );
  return [{ error: `${platformMsg}（${failures.join("；")}）` }];
}

// ========== RSSHub 聚合源 ==========
// RSSHub 新版（2026-09）只输出 RSS XML，.json 后缀已失效（404）；部分平台路由（头条/抖音热榜）
// 已被官方移除，微博/B站/smzdm 从机房 IP 会被上游拦截（503）。可用路由实测：/zhihu/hot、/baidu/top。
// 这里统一用极简正则解析 <item> 的 title/link，兼容 XML 与错误页。
async function rsshubFetch(
  route: string,
  limit = 20,
  // 部分路由（财联社电报）不产出 per-item link，<link/> 为空——此时回退到栏目页，
  // 否则整条被下方 filter 丢弃（等于白拉）。
  fallbackUrl?: string
): Promise<any[]> {
  if (!RSSHUB_BASE) throw new Error("RSSHub 未配置");
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  // 先试 .json（老版本兼容），失败再走纯 RSS XML
  let text = "";
  let res = await fetchWithTimeout(`${RSSHUB_BASE}${route}.json`, { headers }, 8000);
  if (res.ok) {
    text = await res.text();
  } else {
    res = await fetchWithTimeout(`${RSSHUB_BASE}${route}`, { headers }, 8000);
    if (!res.ok) throw new Error(`RSSHub ${route} HTTP ${res.status}`);
    text = await res.text();
  }
  let list: { title?: string; link?: string }[] = [];
  try {
    const json = JSON.parse(text);
    list = Array.isArray(json?.item) ? json.item : [];
  } catch {
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(text)) && list.length < limit) {
      const block = m[1];
      const t = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
      const l = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || "";
      list.push({ title: t, link: l });
    }
  }
  const items = list
    .map((it) => ({
      title: (it?.title || "").toString().trim(),
      url: (it?.link || "").toString().trim() || fallbackUrl || "",
    }))
    .filter((it) => it.title && it.url);
  if (items.length < 3) throw new Error("RSSHub 返回空");
  return items.slice(0, limit).map((it, i) => ({ rank: i + 1, title: it.title, url: it.url }));
}

// ========== Hotboard 聚合站备用源 ==========
// hotboard.lilu.org.cn（个人维护的全网热榜聚合，上游 api.lilu.org.cn）。2026-09-10 实测：
// 无鉴权、服务器直连 200（约 0.1s）；结构 {success, data:{data:[{title,url,mobile_url,hot}]}}。
// 缺点：weibo 等榜单条目 hot 为 null、链接多为站内搜索页（非原文），质量低于各官方主源
// ——只配当主源全挂时的末位兜底，不进首选链路。
// 2026-09-10 全量探测（51 个候选 slug 逐一实测）：知乎位/简书只回 4 条（条数不足）、
// 贴吧/V2EX/HackerNews/Linux.do/NodeSeek/HostLoc/纽约时报 超时、腾讯新闻/豆瓣/历史上的今天 500、
// 网易新闻/水木/吾爱破解/游研社/51CTO/游资网 404，均不接；其余 ≥10 条的 20 个板块已作为
// 独立平台接入（见 PLATFORM_FETCHERS 下方 HOTBOARD_BOARDS 注册表），另给 36氪/虎扑/澎湃 补兜底源。
// （GitHub 本地 16 条可用、但 VPS 出网 25s+ 超时，生产环境用不了，弃。）
async function fetchHotboardHot(board: string, fallbackUrl: string): Promise<any[]> {
  const res = await fetchWithTimeout(
    `https://api.lilu.org.cn/vibe-apps/api/v1/hotboard/${board}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  const json = await res.json();
  const list = Array.isArray(json?.data?.data) ? json.data.data : [];
  const items = list.filter((x: any) => (x.title || "").trim());
  if (items.length < 3) throw new Error("empty");
  return items.slice(0, 20).map((item: any, i: number) => ({
    rank: i + 1,
    title: item.title,
    hot: item.hot || 0,
    url: item.mobile_url || item.url || fallbackUrl,
  }));
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
    async () => {
      // 源3（独立实现路径）：自建 RSSHub /weibo/search/hot（HTML 抓取，非 ajax 接口）
      return rsshubFetch("/weibo/search/hot");
    },
    async () => {
      // 末位兜底（2026-09 新增）：hotboard 聚合站（独立第三方主机），主源全挂时顶上
      return fetchHotboardHot("weibo", "https://s.weibo.com/top/summary");
    },
  ], "weibo", "微博热搜暂时无法获取，建议稍后重试", ["微博Ajax", "DailyHotApi", "RSSHub", "Hotboard"]);
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
    async () => {
      // 源3（独立实现路径）：自建 RSSHub /zhihu/hot
      return rsshubFetch("/zhihu/hot");
    },
  ], "zhihu", "知乎热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "知乎移动API", "RSSHub"]);
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
    async () => {
      // 源3（独立实现路径）：自建 RSSHub /bilibili/ranking/0（全站排行榜）
      return rsshubFetch("/bilibili/ranking/0");
    },
    async () => {
      // 末位兜底（2026-09 新增）：hotboard 聚合站（独立第三方主机），主源全挂时顶上
      return fetchHotboardHot("bilibili", "https://www.bilibili.com/v/popular/rank/all");
    },
  ], "bilibili", "B站热榜暂时无法获取，建议稍后重试", ["B站官方popular", "DailyHotApi", "RSSHub", "Hotboard"]);
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
    async () => {
      // 源5（独立实现路径）：自建 RSSHub /douyin/hot（反爬严格，自建实例才稳）
      return rsshubFetch("/douyin/hot");
    },
    async () => {
      // 末位兜底（2026-09 新增）：hotboard 聚合站（独立第三方主机），主源全挂时顶上
      return fetchHotboardHot("douyin", "https://www.douyin.com/hot");
    },
  ], "douyin", "抖音热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "抖音web", "抖音App", "iesdouyin", "RSSHub", "Hotboard"]);
}

// 小红书官方热搜接口的完整反爬头（取自 baiwumm/next-daily-hot 实测稳定方案）：
// iPhone 微信内嵌浏览器 UA + shield 签名 + xy-* 系列头。桌面 UA + 普通 Referer 经常被 406/301 拦截。
const XHS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.7(0x18000733) NetType/WIFI Language/zh_CN",
  referer: "https://app.xhs.cn/",
  "xy-direction": "22",
  shield:
    "XYAAAAAQAAAAEAAABTAAAAUzUWEe4xG1IYD9/c+qCLOlKGmTtFa+lG434Oe+FTRagxxoaz6rUWSZ3+juJYz8RZqct+oNMyZQxLEBaBEL+H3i0RhOBVGrauzVSARchIWFYwbwkV",
  "xy-platform-info":
    "platform=iOS&version=8.7&build=8070515&deviceId=C323D3A5-6A27-4CE6-AA0E-51C9D4C26A24&bundle=com.xingin.discover",
  "xy-common-params":
    "app_id=ECFAAF02&build=8070515&channel=AppStore&deviceId=C323D3A5-6A27-4CE6-AA0E-51C9D4C26A24&device_fingerprint=20230920120211bd7b71a80778509cf4211099ea911000010d2f20f6050264&device_fingerprint1=20230920120211bd7b71a80778509cf4211099ea911000010d2f20f6050264&device_model=phone&fid=1695182528-0-0-63b29d709954a1bb8c8733eb2fb58f29&gid=7dc4f3d168c355f1a886c54a898c6ef21fe7b9a847359afc77fc24ad&identifier_flag=0&lang=zh-Hans&launch_id=716882697&platform=iOS&project_id=ECFAAF&sid=session.1695189743787849952190&t=1695190591&teenager=0&tz=Asia/Shanghai&uis=light&version=8.7",
};

async function fetchXiaohongshuHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：小红书官方热搜接口（带完整反爬头，2026-07 实测稳定）
      const res = await fetchWithTimeout("https://edith.xiaohongshu.com/api/sns/v1/search/hot_list", {
        headers: XHS_HEADERS,
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
  ], "xiaohongshu", "小红书热榜暂时无法获取（官方接口已限制访问）", ["小红书edith", "小红书页面"]);
}

// 什么值得买：种草/好物/生活方式热榜，作为**独立平台**存在，
// 不再冒充小红书的替代数据。原数据源只有 DailyHotApi（单点），这里补直连官方接口。
async function fetchSmzdmHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/smzdm`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || item.mobileUrl || "",
      }));
    },
    async () => {
      // 源2（独立于 DailyHotApi）：SMZDM 官方排行榜接口。
      // ⚠️ 可能被瑞数 JS 验证拦截（返回 HTML 挑战页），此时 res.json() 抛错，
      // 由 tryFetchSources 兜住继续下一个源，不影响其它平台。
      const res = await fetchWithTimeout("https://post.smzdm.com/rank/json_more/?unit=1", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.smzdm.com/top/",
        },
      });
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.jump_link || "",
      }));
    },
  ], "smzdm", "什么值得买热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "SMZDM官方"]);
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
    async () => {
      // 源3（独立实现路径）：自建 RSSHub /toutiao/hot
      return rsshubFetch("/toutiao/hot");
    },
    async () => {
      // 末位兜底（2026-09 新增）：hotboard 聚合站（独立第三方主机），主源全挂时顶上
      return fetchHotboardHot("toutiao", "https://www.toutiao.com/hot/");
    },
  ], "toutiao", "头条热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "头条官方hot-board", "RSSHub", "Hotboard"]);
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
    async () => {
      // 源3（独立实现路径）：自建 RSSHub /baidu/top（默认实时热搜）
      return rsshubFetch("/baidu/top");
    },
    // ⚠️ 这里曾有个"源3"：百度两路都失败时改抓 DailyHotApi 的 /toutiao，挂在「百度」名下。
    // 已按"是什么源就什么源、出不了就别出、不做硬性替代"移除——头条数据本来就有独立的「头条」平台。
    async () => {
      // 末位兜底（2026-09 新增）：hotboard 聚合站（独立第三方主机），主源全挂时顶上
      return fetchHotboardHot("baidu", "https://top.baidu.com/board?tab=realtime");
    },
  ], "baidu", "百度热搜暂时无法获取，建议稍后重试", ["百度官方top", "DailyHotApi", "RSSHub", "Hotboard"]);
}

// 36氪：科技/互联网/创投向热榜（"科技互联网"领域的垂直来源），作为独立平台单列。
async function fetch36krHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi /36kr（实测 200，返回 50 条，含 url/mobileUrl/hot）
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/36kr`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1,
        title: item.title,
        hot: item.hot || 0,
        url: item.mobileUrl || item.url || "https://m.36kr.com/hot-list-m",
      }));
    },
    async () => {
      // 源2（独立实现路径）：自建 RSSHub /36kr/hot
      return rsshubFetch("/36kr/hot");
    },
    async () => {
      // 末位兜底（2026-09-10 新增）：hotboard（slug 是 kr36 不是 36kr，实测 50 条）
      return fetchHotboardHot("kr36", "https://m.36kr.com/hot-list-m");
    },
  ], "36kr", "36氪热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "RSSHub", "Hotboard"]);
}

// 虎扑步行街：体育/男性社区讨论向热帖，补"体育赛事+社区热议"垂直缺口，作为独立平台单列。
async function fetchHupuHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi /hupu（实测 200，步行街主干道热帖，含 url/mobileUrl/hot）
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/hupu`);
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const items = list.filter((x: any) => (x.title || "").trim());
      if (items.length < 3) throw new Error("empty");
      return items.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1,
        title: item.title,
        hot: item.hot || 0,
        url: item.mobileUrl || item.url || "https://bbs.hupu.com/all-gambia",
      }));
    },
    async () => {
      // 源2（独立实现路径）：自建 RSSHub 虎扑步行街
      return rsshubFetch("/hupu/bxj");
    },
    async () => {
      // 末位兜底（2026-09-10 新增）：hotboard（实测仅 10 条，够兜底用）
      return fetchHotboardHot("hupu", "https://bbs.hupu.com/all-gambia");
    },
  ], "hupu", "虎扑热榜暂时无法获取，建议稍后重试", ["DailyHotApi", "RSSHub", "Hotboard"]);
}

// 财联社电报：财经快讯第一梯队（A股/宏观/全球市场），补"财经专业快讯"垂直缺口。
// 上游官方接口需签名（实测返回 HTML 壳），唯一稳定路径是自建 RSSHub /cls/telegraph。
// 该路由不产出 per-item link（<link/> 为空），用 rsshubFetch 的栏目页回退。
async function fetchClsHot(): Promise<any[]> {
  return tryFetchSources(
    [
      async () => rsshubFetch("/cls/telegraph", 20, "https://www.cls.cn/telegraph"),
    ],
    "cls",
    "财联社快讯暂时无法获取，建议稍后重试",
    ["RSSHub"]
  );
}

// 华尔街见闻：全球财经实时快讯。源1官方 API（api-one.wallstcn.com，2026-09-10 实测 200，
// items[].content_text 纯文本快讯 + uri 可拼详情链）；源2自建 RSSHub /wallstreetcn/live/global。
async function fetchWallstreetcnHot(): Promise<any[]> {
  return tryFetchSources(
    [
      async () => {
        const res = await fetchWithTimeout(
          "https://api-one.wallstcn.com/apiv1/content/lives?channel=global&client=pc",
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          }
        );
        const json = await res.json();
        const list = Array.isArray(json?.data?.items) ? json.data.items : [];
        const items = list
          .map((item: any) => ({
            title: (item?.content_text || "")
              .toString()
              .replace(/\s+/g, " ")
              .trim(),
            uri: (item?.uri || "").toString(),
            time: item?.display_time || 0,
          }))
          .filter((x: any) => x.title);
        if (items.length < 3) throw new Error("empty");
        return items.slice(0, 20).map((x: any, i: number) => ({
          rank: i + 1,
          title: x.title.slice(0, 80),
          hot: x.time,
          url: x.uri
            ? `https://wallstreetcn.com${x.uri}`
            : "https://wallstreetcn.com/live/global",
        }));
      },
      async () =>
        rsshubFetch("/wallstreetcn/live/global", 20, "https://wallstreetcn.com/live/global"),
    ],
    "wallstreetcn",
    "华尔街见闻快讯暂时无法获取，建议稍后重试",
    ["官方API", "RSSHub"]
  );
}

// 澎湃新闻：时政/社会权威媒体热榜，补"官媒时政"垂直缺口（现有平台以聚合/社区向为主）。
// RSSHub 无可用路由（/thepaper/* 实测 404）、官方热榜 API 需签名，单源 DailyHotApi。
async function fetchThepaperHot(): Promise<any[]> {
  return tryFetchSources(
    [
      async () => {
        const res = await fetchWithTimeout(`${DAILYHOT_BASE}/thepaper`);
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        const items = list.filter((x: any) => (x.title || "").trim());
        if (items.length < 3) throw new Error("empty");
        return items.slice(0, 20).map((item: any, i: number) => ({
          rank: i + 1,
          title: item.title,
          hot: item.hot || 0,
          url: item.mobileUrl || item.url || "https://www.thepaper.cn/",
        }));
      },
      async () => {
        // 末位兜底（2026-09-10 新增）：hotboard（实测 20 条）
        return fetchHotboardHot("thepaper", "https://www.thepaper.cn/");
      },
    ],
    "thepaper",
    "澎湃新闻热榜暂时无法获取，建议稍后重试",
    ["DailyHotApi", "Hotboard"]
  );
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
  "36氪": fetch36krHot,
  虎扑: fetchHupuHot,
  财联社: fetchClsHot,
  华尔街见闻: fetchWallstreetcnHot,
  澎湃: fetchThepaperHot,
};

// ========== Hotboard 独立平台（2026-09-10 全量探测后接入）==========
// hotboard 其余可用板块（≥10 条）作为独立平台单列，扩容后端话题素材池。
// 前端 page.tsx 的 PLATFORMS 选择器暂不展示这些平台（用户要求"先接后端，前端先不展示"），
// 模型可通过 fetch_hot_topics 工具按需调用；fetchPlatformsHot 在 platforms 为空（全量抓取）时也会带上。
// 每个板块都是单源（hotboard 无 SLA，个人维护聚合站），失败静默降级为该平台不可用。
const HOTBOARD_BOARDS: {
  name: string;
  board: string;
  key: string;
  fallback: string;
}[] = [
  { name: "快手", board: "kuaishou", key: "kuaishou", fallback: "https://www.kuaishou.com/hot-list" },
  { name: "AcFun", board: "acfun", key: "acfun", fallback: "https://www.acfun.cn/" },
  { name: "新浪", board: "sina", key: "sina", fallback: "https://news.sina.com.cn/" },
  { name: "新浪新闻", board: "sinanews", key: "sinanews", fallback: "https://news.sina.com.cn/" },
  { name: "IT之家", board: "ithome", key: "ithome", fallback: "https://www.ithome.com/" },
  { name: "掘金", board: "juejin", key: "juejin", fallback: "https://juejin.cn/hot/articles" },
  { name: "少数派", board: "sspai", key: "sspai", fallback: "https://sspai.com/" },
  // GitHub 板块本地可达（16 条）但 VPS 实测连续 25s+ 超时（hotboard 的 github 上游被机房
  // 网络掐断），生产 8s 超时下永远失败 → 不接。
  { name: "HelloGitHub", board: "hellogithub", key: "hellogithub", fallback: "https://hellogithub.com/" },
  { name: "CSDN", board: "csdn", key: "csdn", fallback: "https://www.csdn.net/" },
  { name: "虎嗅", board: "huxiu", key: "huxiu", fallback: "https://www.huxiu.com/" },
  { name: "爱范儿", board: "ifanr", key: "ifanr", fallback: "https://www.ifanr.com/" },
  { name: "极客公园", board: "geekpark", key: "geekpark", fallback: "https://www.geekpark.net/" },
  { name: "果壳", board: "guokr", key: "guokr", fallback: "https://www.guokr.com/" },
  { name: "数字尾巴", board: "dgtle", key: "dgtle", fallback: "https://www.dgtle.com/" },
  { name: "微信读书", board: "weread", key: "weread", fallback: "https://weread.qq.com/" },
  { name: "NGA", board: "ngabbs", key: "ngabbs", fallback: "https://bbs.nga.cn/" },
  { name: "米游社", board: "miyoushe", key: "miyoushe", fallback: "https://www.miyoushe.com/" },
  { name: "英雄联盟", board: "lol", key: "lol", fallback: "https://lol.qq.com/" },
  { name: "天气预警", board: "weatheralarm", key: "weatheralarm", fallback: "https://www.nmc.cn/" },
  { name: "地震速报", board: "earthquake", key: "earthquake", fallback: "https://news.ceic.ac.cn/" },
];
for (const hb of HOTBOARD_BOARDS) {
  PLATFORM_FETCHERS[hb.name] = () =>
    tryFetchSources(
      [async () => fetchHotboardHot(hb.board, hb.fallback)],
      hb.key,
      `${hb.name}热榜暂时无法获取，建议稍后重试`,
      ["Hotboard"]
    );
}

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
            // 动态取自 PLATFORM_FETCHERS 全部键（含 hotboard 独立平台），新增平台自动同步
            enum: Object.keys(PLATFORM_FETCHERS),
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
      description:
        "根据热点生成可直接照读的短视频口播稿。用户表达了明确观点/判断/态度（哪怕只有一句，如'X是因为…''我觉得…本质是…'）时，必须把原话放进 plot 并注明这是观点；用户只给事实/素材/中立要求时 plot 留空或放中性提纲。用户指定了视频时长（如30秒/1分钟/3分钟）时传 duration 和 wordRange。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "选定的热点话题标题" },
          domain: { type: "string", description: "创作领域" },
          style: { type: "string", description: "脚本风格，如：口播、剧情、知识分享" },
          plot: {
            type: "string",
            description:
              "用户在故事梗概/想法里给出的内容原文：表达了主观判断或因果主张时原样放入（系统会据此走观点评论稿，严禁替用户中立化）；只是事实素材或中立要求时也放这里，没有可留空",
          },
          duration: { type: "string", description: "目标时长档位原文，如 30秒/1分钟/3分钟；未指定留空" },
          wordRange: { type: "string", description: "时长对应的字数区间原文，如 90-110字/540-660字；未指定留空" },
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
  {
    type: "function" as const,
    function: {
      name: "search_web_fact",
      description:
        "联网核实具体事实：人物/战队/俱乐部/公司/作品的归属、身份、头衔、数据、近期动态等。凡是要在回复里陈述这类容易记错的事实细节，必须先调用本工具核实再答，禁止仅凭记忆给出；检索结果与你的记忆冲突时，以检索结果为准。仅用于事实核实，不要用于抓热榜。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要核实的事实检索词，例如「zont1x CS2 选手 战队」",
          },
        },
        required: ["query"],
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
    test: /^电竞$/,
    note: "电子竞技相关：职业电竞赛事与赛果、电竞选手与战队动态（转会/退役/夺冠/禁赛）、游戏版本更新、游戏发布会、主播与解说、电竞产业；网游手游本身的大版本/赛事也算。纯娱乐圈明星综艺不算。",
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
    const res: string = await callLLM([{ role: "user", content: prompt }], false, 0);
    const m = res.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  } catch (e) {
    console.warn("[chat] 搜索关键词扩展 LLM 解析失败，降级为空词表:", (e as Error)?.message || e);
  }
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
    const res: string = await callLLM([{ role: "user", content: prompt }], false, 0);
    const m = res.match(/\[[\s\S]*\]/);
    if (!m) return items;
    const keep = new Set<number>(
      (JSON.parse(m[0]) as unknown[]).filter((n): n is number => Number.isInteger(n))
    );
    return items.filter((_, i) => keep.has(i));
  } catch (e) {
    console.warn(`[chat] 领域「${name}」含义过滤 LLM 解析失败，降级保留全部候选:`, (e as Error)?.message || e);
    return items;
  }
}

// 今日热点·领域相关性判定（两阶段：embedding 粗召回 + LLM 分级精排）。
// 历史教训（2026-09 用户实证 + 当日榜单复盘）：旧实现让 LLM 对全榜裸标题做二元判定
//（40条/块），配合"绕两层弯即剔/拿不准就剔"的精度导向措辞，在「女性主义」这类标题几乎
// 不直写领域名、需要代入议题与人群做推断的领域上【系统性全灭】——当日知乎热榜明明有
// "女子称被公职人员强奸、公安不予立案，市公安复核认定有犯罪事实"这种核心议题也返回 []。
// 文献依据（arxiv 2510.16091，文献筛选场景与本题同构）：高灵敏度筛查应最大化召回、
// 用分级标注替代二元判定、CoT 理由显著改善边界条目；RAG 工程共识是"向量粗召回保不漏、
// 模型精排保准确"。当日实测（2026-09-13 真实榜单）：本地 bge 粗召回能捞出上述强奸案、
// "女子无配偶子女9亲戚争遗产"等 LLM 漏掉的题，但也混入"女生看大国基建"噪声——
// 证明两阶段缺一不可。本实现：
//   阶段0 跑口画像：有用户/内置释义直接用；没有则让 LLM 就领域名生成一段"该跑口读者
//          关心的议题/人群/争议"中立描述（内容中立机制，不内置任何领域词表）；
//   阶段1 向量粗召回：全榜标题走内网 CPU embedding（去重缓存 30min + 40条并行，实测
//          约3-6s/150条），用"领域名/画像"两个查询向量取最大余弦，取前 35 条候选；
//   阶段2 LLM 分级精排：只对短候选表输出 2/1/0 三级 + 一句理由，高灵敏度口径"有疑问给1"；
//   阶段3 全灭救援：精排全 0 时，再以"主编要求今天无论如何给该领域读者推几条"的视角从
//          候选补选（≤3 条、标1级），真没有才允许 []；
// embedding 服务任何异常都静默回退到"全量 40 条/块 LLM 分级判定"。
const RAG_EMBED_URL = (process.env.RAG_URL || "http://127.0.0.1:8091").replace(/\/+$/, "") + "/embed";
const MATCH_CANDIDATE_K = 35;
const MATCH_EMBED_TTL_MS = 30 * 60 * 1000;
const MATCH_EMBED_CHUNK = 40;

function normalizeVec(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// 本地 embedding 服务批量转向量；任何失败返回 null（调用方回退全量 LLM 判定）。
async function localEmbed(
  texts: string[],
  isQuery: boolean
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += MATCH_EMBED_CHUNK) {
    batches.push(texts.slice(i, i + MATCH_EMBED_CHUNK));
  }
  try {
    const outs = await Promise.all(
      batches.map(async (batch) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const res = await fetch(RAG_EMBED_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ texts: batch, is_query: isQuery }),
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error("embed http " + res.status);
          const d = await res.json();
          let v: any = d?.embeddings ?? d?.data ?? d?.vectors ?? d;
          // 注意：number[] 的 typeof 也是 "object"，必须先排除数组，否则数字向量会被
          // 误当成 {embedding} 对象 map 成 undefined（运行时 x is not iterable）。
          if (
            Array.isArray(v) &&
            v.length > 0 &&
            v[0] &&
            !Array.isArray(v[0]) &&
            typeof v[0] === "object"
          ) {
            v = v.map((x: any) => x?.embedding ?? x?.vector);
          }
          if (
            !Array.isArray(v) ||
            v.length !== batch.length ||
            !v.every((x: any) => Array.isArray(x) && x.length > 0)
          ) {
            throw new Error("embed shape mismatch");
          }
          return v as number[][];
        } finally {
          clearTimeout(timer);
        }
      })
    );
    return outs.flat();
  } catch (e) {
    console.warn(
      "[chat] 本地 embedding 粗召回不可用，回退全量 LLM 判定:",
      (e as Error)?.message || e
    );
    return null;
  }
}

// 全榜标题 embedding 的去重缓存：30min 内同一份标题数组只算一次；多领域并行判定共享。
let titleEmbedJob:
  | { key: string; at: number; job: Promise<number[][] | null> }
  | null = null;
async function embedTitlesCached(
  titles: string[]
): Promise<number[][] | null> {
  const key = titles.join("");
  const now = Date.now();
  if (
    titleEmbedJob &&
    titleEmbedJob.key === key &&
    now - titleEmbedJob.at < MATCH_EMBED_TTL_MS
  ) {
    return titleEmbedJob.job;
  }
  const job = localEmbed(titles, false);
  titleEmbedJob = { key, at: now, job };
  job
    .then((v) => {
      if (!v) titleEmbedJob = null;
    })
    .catch(() => {});
  return job;
}

// 跑口画像：无释义时让 LLM 就领域名生成一段关注范围描述（缓存、并发去重）。
const beatProfileJobs = new Map<string, Promise<string>>();
function getBeatProfile(name: string, meaning: string): Promise<string> {
  const m = meaning.trim();
  if (m) return Promise.resolve(m);
  const n = name.trim();
  const hit = beatProfileJobs.get(n);
  if (hit) return hit;
  const job = (async () => {
    const prompt = `我在做"按领域筛今日热点"的功能，领域是「${n}」，没有额外释义。
请用不超过120字的大白话，写清长期关注这个领域的读者/编辑真正关心的是哪些议题、哪类人群、哪些处境与争议，供判断热点相关性时使用。
只输出这段描述本身：连贯成句，不要分条、不要罗列关键词、不要标题和任何解释。`;
    try {
      const res: string = await callLLM(
        [{ role: "user", content: prompt }],
        false,
        0.3
      );
      return (res || "").trim().slice(0, 300) || n;
    } catch {
      return n;
    }
  })();
  beatProfileJobs.set(n, job);
  return job;
}

// 分级精排的提示词构造。rescue=true 时走"全灭救援"视角（同一对话的追问，list 不再重复）。
function buildGradePrompt(
  name: string,
  profile: string,
  list: string,
  rescue: boolean
): string {
  if (!rescue) {
    return `你是「${name}」领域的资深跑口编辑。这是机器用向量从今日各平台实时热榜里【粗筛出的候选标题】（编号见行首，格式"编号. 平台｜标题"），需要你逐条精筛。
这个领域的关注范围：${profile}
重要前提：候选是机器粗筛的，可能整批都与本领域无关，也可能混着真相关。不要因为这批标题大多提到某个人群、某个词就放宽标准，每条都用同一把尺独立判断。
按三级打分：
- 2 直接相关：新闻核心就是该领域在讨论的议题（事件、争议、政策、现象、核心人物动态），标题不必出现领域名；
- 1 间接相关：新闻核心是别的事，但报道重心明确落在该领域关注人群/对象的处境、障碍、选择、争议或代表性突破上，这条新闻的公共意义与该领域有关；
- 0 无关：当事人或事物只是【恰好属于】该人群、或与领域名词字面撞词，新闻本身其实是赛果、案情、灾祸、通报、娱乐、消费等别的内容；或要绕两层以上弯才沾边。
硬性纪律：
1. 只能依据标题字面信息判断，不许补充标题之外的背景、身份或立场；标题没说的身份不许假设。
2. 定级理由必须先引用标题里支撑你定级的原词（加引号），再写理由；标题中找不到任何支撑短语的，判0。
3. 高灵敏度是为了不漏掉"标题没出现领域名、但议题确实相关"的新闻，不是给所有沾边的条目凑数；真正在1和0之间无法决断时才给1。不设数量配额，可以有多条2，也可以全部0。
4. 标题只出现泛指通用词（如选手、比赛、家长、学生、儿童、女性、消费者）而没有该领域特有的赛事/机构/产品/人物/议题专名时，不许据此把新闻归入该领域。明确禁止这样的推理："该领域会关注某类议题，这条标题正好提到这类议题的通用词，所以相关"——"选手权益""赛事规则""儿童安全"这类通用词组可以属于任何领域，不构成当前领域的证据；也不许因为同一批里其他条目属于该领域，就默认这一条也属于。特别地：若条目只是某人（评论员、网友、名人）对一起未标明项目/领域的具体事件发表个人态度，判0；"可能是这个领域"不构成证据，证据不足即0。例外：事件核心是官方/联盟/机构作出的制度性决定（禁赛、处罚、规则修订、政策发布），即使没写专名，也按议题实质判断。
5. 单个当事人的事故、伤亡、灾祸、案情，即使当事人恰好属于关注人群、评论里提到设施或责任问题，也按灾祸/案情判0；只有新闻核心本身就是该领域的制度、政策、行业性、普遍性争议时，才可判1及以上。
只输出一个 JSON 数组，不要任何解释，格式：[{"i":序号整数,"lvl":0或1或2,"why":"先引标题原词，再写理由，共≤25字"}]

${list}`;
  }
  return `你上一步把这批候选全判成了 0。请换主编视角复核一次：今天如果确实有值得给「${name}」读者看的，请从中挑出【最多3条】关联相对最强的按 lvl=1 选入，并写清这条新闻的公共讨论点与该领域的实质关联。
前提是新闻内容本身与该领域有实质关联，仅当事人身份相同不算；如果确实没有任何一条相关，允许返回 []，不要凑数。
同样只输出 JSON 数组：[{"i":序号整数,"lvl":1,"why":"20字内中文理由"}]`;
}

// 灰区（批量判 1）条目独立复核时追加的话术。eval/grade-golden.mjs 按标记从本文件
// 抽取同样段落，保证门禁与线上同流程；勿改标记。
// 宽松复核（非对称举证）：只有明确无关才改 0，专门负责保住间接相关题。
const GRADE_REVIEW_NOTE = /* grade-review-note-start */ `
补充：该条此前在一批新闻中被初判为1。请忽略那个批次和初判，只凭这一条独立复核：只有当你【明确】认为它与本领域无关时才输出0；在0和1之间拿不准，就保留1。仍只输出那个JSON数组。`; /* grade-review-note-end */
// 反驳式复核：把初判理由交给单条复核员，要求判断理由是"实质关联"还是"通用词复述"。
// __WHY__ 处替换为批量阶段给出的定级理由。
const GRADE_APPEAL_NOTE = /* grade-appeal-note-start */ `
补充：该条此前在一批新闻中被初判为1，初判理由是"__WHY__"。请你只凭这一条独立复核这个理由是否站得住：
- 如果该理由只是把"选手、比赛、儿童、女性、消费者、科技"之类的通用词复述成领域议题，而标题字面里并没有该领域特有的专名或该领域特有的议题实质，输出0；
- 如果该理由说的实质关联在标题字面里确实成立，保留1。
仍只输出那个JSON数组。`; /* grade-appeal-note-end */

// 灰区复核：同一条目 3 票独立判断，全部 temperature=0（确定性，可回归），靠话术产生视角差异：
// 票1 严格单条（无上下文）；票2 反驳式（带批量理由，识别"通用词复述"）；票3 宽松非对称（保召回）。
// ≥2 票判 0 才把批量阶段的 1 否决为 0。数据标定：无领域锚点的观点转述/个体事故在 3 票上
// 稳定拿到 ≥2 个 0；间接相关题总有票识别出实质关联（各轮实测核心题 0 错杀，仅个别边界间接题
// 被过滤，总召回≥0.93）。目的是消除"整批条目同领域"的上下文锚定（实测同质批次会让模型
// 把无领域锚点的条目默认为同领域），同时保护批量阶段已识别出的间接相关题，避免错杀。
type ReviewMode = "plain" | "appeal" | "loose";
const REVIEW_VOTES: ReviewMode[] = ["plain", "appeal", "loose"];
const REVIEW_GRAY_MAX = 20; // 灰区过大（异常情况）时放弃复核，fail-open 保召回
const REVIEW_CONCURRENCY = 3; // 每条 3 票，并发上限 3 条目（≈9 路请求），避免触发 API 限流
const REVIEW_RETRY_MS = 800; // 限流/偶发失败时等一次再试，仍失败才 fail-open

// 对批量精排判为 1（间接相关）的灰区条目逐条独立复核，返回应否决（降为0）的序号集合。
// 任何技术失败一律 fail-open：该票视为"保留"，整体不可用时返回空集。
async function reviewGrayVetoes(
  name: string,
  profile: string,
  items: { platform: string; title: string }[],
  gray: { i: number; why: string }[]
): Promise<Set<number>> {
  const vetoes = new Set<number>();
  if (gray.length === 0 || gray.length > REVIEW_GRAY_MAX) return vetoes;

  async function oneVote(item: { i: number; why: string }, mode: ReviewMode): Promise<number> {
    const callOnce = async (): Promise<number> => {
      const { i } = item;
      const solo = `${i}. ${items[i].platform}｜${items[i].title}`;
      let content = buildGradePrompt(name, profile, solo, false);
      if (mode === "loose") content += GRADE_REVIEW_NOTE;
      if (mode === "appeal")
        content += GRADE_APPEAL_NOTE.replace(
          "__WHY__",
          (item.why || "").replace(/["\n]/g, " ").slice(0, 60)
        );
      const res = await callLLM([{ role: "user", content }], false, 0);
      // 单条复核正常应返回单元素数组；JSON 损坏（裸引号、截断缺括号）时退化为直接抽 lvl
      const mm = res.match(/\[[\s\S]*?\]/);
      if (mm) {
        try {
          const arr = JSON.parse(mm[0]) as any[];
          const o = arr.find((x) => Number(x?.i) === i) || arr[0];
          if (o && (Number(o.lvl) === 0 || Number(o.lvl) === 1 || Number(o.lvl) === 2))
            return Number(o.lvl) === 0 ? 0 : 1;
        } catch {
          // 落到正则
        }
      }
      const lm = res.match(/"lvl"\s*:\s*([012])/);
      return lm && lm[1] === "0" ? 0 : 1;
    };
    try {
      return await callOnce();
    } catch {
      await new Promise((r) => setTimeout(r, REVIEW_RETRY_MS));
      try {
        return await callOnce();
      } catch {
        return 1;
      }
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < gray.length) {
      const item = gray[cursor++];
      const votes = await Promise.all(REVIEW_VOTES.map((mode) => oneVote(item, mode)));
      if (votes.filter((v) => v === 0).length >= 2) vetoes.add(item.i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REVIEW_CONCURRENCY, gray.length) }, () => worker())
  );
  return vetoes;
}

// 对给定候选（全局序号数组）做一次分级精排。
// 返回：解析成功→{ set: 命中序号集合（可能空集）, lvl: 序号→{g:1|2, why} }；技术失败→null。
async function gradeCandidates(
  name: string,
  profile: string,
  items: { platform: string; title: string }[],
  candIdx: number[],
  rescue: boolean
): Promise<{ set: Set<number>; lvl: Map<number, { g: number; why: string }> } | null> {
  if (candIdx.length === 0)
    return { set: new Set<number>(), lvl: new Map() };
  const list = candIdx
    .map((i) => `${i}. ${items[i].platform}｜${items[i].title}`)
    .join("\n");
  const messages: any[] = [
    { role: "user", content: buildGradePrompt(name, profile, list, false) },
  ];
  if (rescue) {
    messages.push({
      role: "assistant",
      content: "[]",
    });
    messages.push({
      role: "user",
      content: buildGradePrompt(name, profile, list, true),
    });
  }
  let res: string;
  try {
    res = await callLLM(messages, false, 0);
  } catch (e) {
    console.warn(
      `[chat] 领域「${name}」热点分级精排调用失败:`,
      (e as Error)?.message || e
    );
    return null;
  }
  try {
    const m = res.match(/\[[\s\S]*?\]/);
    if (!m) return rescue ? { set: new Set<number>(), lvl: new Map() } : null;
    const arr = JSON.parse(m[0]) as any[];
    const set = new Set<number>();
    const lvl = new Map<number, { g: number; why: string }>();
    for (const o of arr) {
      const i = Number(o?.i);
      const g = Number(o?.lvl);
      if (
        Number.isInteger(i) &&
        i >= 0 &&
        i < items.length &&
        candIdx.includes(i) &&
        (g === 1 || g === 2)
      ) {
        set.add(i);
        // rescue 轮 prompt 口径是"保底捞间接相关"，统一记 1
        lvl.set(i, { g: rescue ? 1 : g, why: String(o?.why || "") });
      }
    }
    return { set, lvl };
  } catch (e) {
    console.warn(
      `[chat] 领域「${name}」热点分级精排结果解析失败:`,
      (e as Error)?.message || e,
      res.slice(0, 200)
    );
    return null;
  }
}

async function matchTodayTopics(
  name: string,
  meaning: string,
  items: { platform: string; title: string }[]
): Promise<Set<number>> {
  if (items.length === 0) return new Set();
  const profile = await getBeatProfile(name, meaning);

  // 阶段1：向量粗召回（标题 embedding 与查询 embedding 并行）。
  const [tVecs, qVecs] = await Promise.all([
    embedTitlesCached(items.map((it) => it.title)),
    localEmbed(
      [name.trim(), profile].filter((x) => x && x.trim()).slice(0, 2),
      true
    ),
  ]);

  if (tVecs && qVecs && tVecs.length === items.length && qVecs.length > 0) {
    try {
      const qn = qVecs.map(normalizeVec);
      const scored = tVecs.map((v, idx) => {
        const n = normalizeVec(v);
        let best = -2;
        for (const q of qn) {
          let d = 0;
          for (let k = 0; k < n.length; k++) d += n[k] * q[k];
          if (d > best) best = d;
        }
        return { idx, s: best };
      });
      scored.sort((a, b) => b.s - a.s);
      const cand = scored
        .slice(0, Math.min(MATCH_CANDIDATE_K, scored.length))
        .map((x) => x.idx);

      // 阶段2：分级精排（批量）。
      const kept = await gradeCandidates(name, profile, items, cand, false);
      if (kept && kept.set.size > 0) {
        // 阶段2.5：批量判 1 的灰区条目做 3 票独立复核，消除同批锚定导致的误纳。
        const gray = [...kept.lvl.entries()]
          .filter(([, v]) => v.g === 1)
          .map(([i, v]) => ({ i, why: v.why }));
        const vetoes = await reviewGrayVetoes(name, profile, items, gray);
        if (vetoes.size > 0) for (const i of vetoes) kept.set.delete(i);
        return kept.set;
      }
      // 阶段3：全灭救援（仅在模型明确判全 0、不是技术失败时触发）。救援结果不再复核，保召回。
      if (kept) {
        const rescued = await gradeCandidates(
          name,
          profile,
          items,
          cand,
          true
        );
        if (rescued) return rescued.set;
      }
      return new Set<number>();
    } catch (e) {
      console.warn(
        `[chat] 领域「${name}」两阶段相关性判定异常，回退分块 LLM:`,
        (e as Error)?.message || e
      );
    }
  }

  // 回退路径：embedding 不可用时，全量 40 条/块做同样的分级精排（无向量预筛，注意力预算小）。
  const CHUNK = 40;
  const ranges: number[][] = [];
  for (let s = 0; s < items.length; s += CHUNK) {
    ranges.push(
      Array.from({ length: Math.min(CHUNK, items.length - s) }, (_, k) => s + k)
    );
  }
  const judged = await Promise.all(
    ranges.map((cand) => gradeCandidates(name, profile, items, cand, false))
  );
  const mergedSet = new Set<number>();
  const mergedLvl = new Map<number, { g: number; why: string }>();
  for (const r of judged) {
    if (!r) continue;
    for (const [i, v] of r.lvl) {
      mergedSet.add(i);
      // 同一序号不会跨块；2 优先于 1 仅作防御
      const prev = mergedLvl.get(i);
      if (!prev || v.g > prev.g) mergedLvl.set(i, v);
    }
  }
  const gray = [...mergedLvl.entries()]
    .filter(([, v]) => v.g === 1)
    .map(([i, v]) => ({ i, why: v.why }));
  const vetoes = await reviewGrayVetoes(name, profile, items, gray);
  for (const i of vetoes) mergedSet.delete(i);
  return mergedSet;
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

  const collect = async (): Promise<
    { title: string; url: string; source: string; published?: string }[]
  > => {
    const merged: { title: string; url: string; source: string; published?: string }[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      // 三路并集（不限时+近30天+视频）：内置时间维度放宽（新帖优先、旧的兜底），单轮即可
      const items = await searxUnionSearch(q, limit);
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

  const out = await collect();
  // 剔除明显不符领域原意的结果（如「bg=男女cp」误命中地球科学期刊 BG、国家代码等）
  const relevant = await filterByRelevance(d, note, out);
  // Fail-open（2026-09 评测实证）：相关性过滤的 prompt 要求"拿不准就按不符合"，实测会把
  // 按领域原短语（如「女性成长」）搜回的 12+ 条结果【全部】判死，用户端看到"近30天也未找到"。
  // 对【自描述中文短语】领域（isDescriptivePhrase，检索词本身就是领域含义），全灭判定不可信
  // ——原短语搜索的结果天然围绕该主题，误删代价（用户无内容可看）远大于误留，退回保留原结果。
  // 纯拉丁/缩写歧义领域（bg/bl 等同名异物高发）仍 fail-closed。
  if (relevant.length === 0 && out.length > 0 && isDescriptivePhrase) {
    // 二次救援（2026-09 评测实证）：直接退回原始结果会混入与领域零关系的跑题 spam
    //（贴吧网盘/小说资源页）。退回前做一道轻量词面过滤——标题需命中检索词的中文二字
    // 片段（如「女性成长」→女性/成长）或拉丁整词。宁可少留几条，也不给用户推垃圾页。
    const terms = new Set<string>();
    for (const q of queries) {
      for (const run of q.match(/[\u4e00-\u9fff]{2,}/g) || []) {
        terms.add(run);
        for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
      }
      for (const w of q.match(/[a-zA-Z0-9]{3,}/g) || []) terms.add(w.toLowerCase());
    }
    const rescued = out.filter((it) => {
      const t = (it.title || "").trim();
      if (!t || isResourceSpam(t, it.source || "")) return false;
      if (terms.size === 0) return true;
      return [...terms].some((x) =>
        /[a-z0-9]/.test(x[0]) ? t.toLowerCase().includes(x) : t.includes(x)
      );
    });
    if (rescued.length > 0) return rescued.slice(0, limit);
    return out.filter((it) => !isResourceSpam(it.title || "", it.source || "")).slice(0, limit);
  }
  // spam 黑名单对所有路径生效（2026-09 评测实证）：盗版资源/小说引流页即使被相关性
  // LLM 误判为相关，也绝不能推给做内容的用户。
  return relevant
    .filter((it) => !isResourceSpam(it.title || "", it.source || ""))
    .slice(0, limit);
}

// 盗版资源 / 网文引流 spam 判定（2026-09 评测实证）：贴吧等来源常返回「《XX》网盘/高清/
// 在线观看/全集/230集」这类资源页，或论坛内部回帖串（"回复：……"）、粉丝骂战串，
// 与任何创作领域的选题参考都无关。标题与来源任一命中即判垃圾。
function isResourceSpam(title: string, source: string): boolean {
  const t = title || "";
  const s = source || "";
  return (
    /网盘|百度云|云盘|资源下载|高清下载|免费下载|免费观看|在线观看|4K|全集|追书|txt下载|迅雷下载|小说《|短剧《|言情文|古言|第\d+集|\d+集[）)]|^\s*回复[:：]|^吧友|极端粉丝|骂战/.test(t) ||
    /免费短剧|资源|追剧|追书|悦书|书吧|贴吧/.test(s)
  );
}

// 本轮全网搜索参考来源（2026-09 统一收口）：只要本轮启用了全网搜索——主体预取四路、
// search_web_fact、近30天兜底/稀疏补挂、脚本事实核实——实际命中的链接都收集进 turnRefs，
// 随响应 refs:{sites,videos} 返回，前端在【第一层回复】下渲染默认折叠的参考网站/参考视频。
// 历史兼容：旧版本曾把 %%REFS%% 单行标记拼进正文（前端仍能解析存量消息），新链路统一走结构化字段。
// 视频链接判定（与 detail/route.ts 的 isVideoUrl 同口径）：命中的归"参考视频"，其余归"参考网站"
const VIDEO_REF_RE =
  /bilibili\.com\/video|b23\.tv|youtube\.com\/watch|youtu\.be|douyin\.com|v\.douyin\.com|kuaishou\.com|v\.qq\.com|ixigua\.com/;
type ChatRef = { t: string; u: string; s?: string; d?: string };

// 把近30天兜底结果直接拼进最终回复正文（不再用气泡框）。
// 条目按"序号. [日期] 来源｜标题"格式输出，和今日热点列表同构，
// 前端 renderAssistantContent 会自动给每条挂"查看详情"按钮。
// 日期标签（[YYYY-MM-DD]）来自三路并集检索的 published 字段，让模型与用户一眼识别新帖。
function appendRecentFallback(
  content: string,
  fb: {
    domain: string;
    items: { title: string; url: string; source: string; published?: string }[];
  } | null
): string {
  if (!fb || !fb.items || fb.items.length === 0) return content;
  const domainLabel = fb.domain || "该领域";
  const lines = fb.items.map((it, i) => {
    const src = (it.source || "").trim();
    const title = (it.title || "").trim();
    const date = (it.published || "").trim();
    return `${i + 1}. ${date ? `[${date}] ` : ""}${src ? `${src}｜` : ""}${title}`;
  });
  const block =
    `\n\n---\n📌 今日各平台实时热榜暂无与「${domainLabel}」直接相关的热点，` +
    `以下是近期检索到的 ${fb.items.length} 条相关内容（含近30天新帖与更早的背景资料，按新帖优先排序，非今日实时热榜，仅供参考）：\n\n` +
    lines.join("\n");
  // 参考链接由调用方统一收集进 turnRefs，随响应 refs 结构化返回（不再拼正文标记）
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
    const res: string = await callLLM([{ role: "user", content: prompt }], false, 0);
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
  } catch (e) {
    console.warn("[chat] 今日热点批量打标 LLM 解析失败，降级用已有部分标签:", (e as Error)?.message || e);
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
  // 阶段3 故障可视化：某平台全部数据源失败时（fetcher 返回 [{error}]），
  // 不再静默消失，在末尾补一行"⚠️ 平台：失败原因"。
  const notices: string[] = [];
  for (const [platform, topics] of fetchedByPlatform) {
    if (!Array.isArray(topics) || topics.length === 0) continue;
    const titles = topics
      .slice(0, perPlatform)
      .map((t: any) => (t?.title || t?.word || t?.name || "").toString().trim())
      .filter(Boolean);
    if (titles.length === 0) {
      const err = topics[0]?.error;
      if (err) notices.push(`⚠️ ${platform}：${err}`);
      continue;
    }
    perPlatformTitles.push({ platform, titles });
    for (const title of titles) all.push({ platform, title });
  }
  if (all.length === 0 && notices.length === 0) return "";

  // 展示标签只标每条最核心的 1-3 个领域（逐条选主领域），避免"沾边就挂"糊成一片。
  const tagsByIndex =
    all.length > 0
      ? await tagTopicsCoreDomains(all, domainUniverse, userGlossary)
      : new Map<number, string[]>();

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
  const body = [blocks.join("\n\n"), ...notices].filter(Boolean).join("\n\n");
  if (!body) return "";
  return (
    `已从各平台抓取今日实时热榜（未指定领域，按各平台热度展示前 ${perPlatform} 条，不做领域筛选，仅按分类打标签）：\n\n` +
    body +
    `\n\n如需只看某个领域，在顶部「领域」里选择后再让我抓一次即可。`
  );
}

// 未选领域时的【确定性兜底抓取】：不依赖模型是否调用 fetch_hot_topics。
// 模型有时不抓新榜，而是直接用对话历史里的旧领域回复（甚至调 search_recent_topics_by_domain
// 拉旧领域的近30天内容），导致 renderAllPlatformsHot 因 fetchedByPlatform 为空而被绕过——
// 这就是"没选领域却按旧领域乱筛/漏垃圾"的根因。这里在服务端按用户当前选中的平台直接抓，
// 保证"没选领域 → 出各平台前20条"这条铁律 100% 生效，与模型是否听话无关。
// 热榜分钟级缓存（2026-09）：同一份平台列表 90 秒内的重复抓取直接复用，并合并并发请求
// （entity 轮/工具循环/短时间连续点击原本每次都全量抓 8 平台，单次 20~40s）。
// 热榜数据分钟级新鲜度足够；返回副本，避免调用方污染共享缓存。
const HOT_CACHE_TTL_MS = 90_000;
const hotCache = new Map<string, { at: number; map: Map<string, any[]> }>();
const hotInflight = new Map<string, Promise<Map<string, any[]>>>();

async function fetchPlatformsHotRaw(
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
      } catch (e) {
        console.warn(`[chat] 热榜平台「${name}」抓取失败，跳过该平台:`, (e as Error)?.message || e);
      }
    })
  );
  return map;
}

async function fetchPlatformsHot(
  platforms: string[]
): Promise<Map<string, any[]>> {
  const key = (Array.isArray(platforms) ? platforms : [])
    .map((p) => (p || "").toString().trim())
    .filter(Boolean)
    .sort()
    .join("|"); // 空串 = 全量；顺序无关
  const hit = hotCache.get(key);
  if (hit && Date.now() - hit.at < HOT_CACHE_TTL_MS) {
    return new Map(hit.map);
  }
  const running = hotInflight.get(key);
  if (running) return running.then((m) => new Map(m));
  const job = fetchPlatformsHotRaw(platforms)
    .then((m) => {
      hotCache.set(key, { at: Date.now(), map: m });
      hotInflight.delete(key);
      return m;
    })
    .catch((e) => {
      hotInflight.delete(key);
      throw e;
    });
  hotInflight.set(key, job);
  return job.then((m) => new Map(m));
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

// 任务模式防泄漏（B5）：用户在要求具体产出任务（润色/改写/翻译/写稿等）时，回复若混入了两区
// 结构（直接相关的切入/结合你选中的领域）或结构收尾句，都是模板惯性泄漏——提示词禁令对模型
// 习惯抑制不稳定，服务端从第一个结构标题起整块截除（任务回复必须纯净）。
// 非任务消息保持原行为：有两区标题的正常结构回复不动，只清"没有标题却带结构收尾句"的惯性尾巴。
// TASK_VERB_RE 与意图兜底共用同一份，定义在 lib/intent.ts。
function stripStructureLeak(userMsg: string, content: string): string {
  let c = (content || "").trimEnd();
  if (!c) return c;
  if (TASK_VERB_RE.test(userMsg || "")) {
    const starts = [
      c.indexOf("直接相关的切入"),
      c.indexOf("特质衍生的切入"),
      c.indexOf("相关领域的切入"),
      c.indexOf("结合你选中的领域"),
    ]
      .filter((x: number) => x >= 0)
      .sort((a: number, b: number) => a - b);
    if (starts.length) {
      c = c.slice(0, starts[0]);
      c = c.replace(/\n(?![^\n]*>)[^\n]*[：:]\s*$/, "").trimEnd(); // 标题前的引导句
      c = c.replace(/\n[-—–]{3,}\s*$/, "").trimEnd(); // 分隔线
    }
    return c
      .replace(
        /(?:需要的话[^\n。]{0,40})?这些方向同样可以让我深挖资料或直接写稿[。．.！!～~]*\s*$/,
        ""
      )
      .trimEnd();
  }
  // meta 思考泄漏截除：四步结构要求从【主体速览】起头，但模型偶发在正文前输出思考
  // 过渡说明（如英文 "The searches didn't... Let me use those"）——用户可见的垃圾文本。
  // 【热榜速报】单行短句是唯一允许出现在【主体速览】之前的内容（前端渲染成灰条提示），保留之；
  // 其余正文前文本一律确定性截掉（纯问答/任务回复没有该标记则不动）。
  const sv = c.indexOf("【主体速览】");
  if (sv > 0) {
    const hb = c.indexOf("【热榜速报】");
    if (hb >= 0 && hb < sv) {
      const hbLine =
        c
          .slice(hb, sv)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("【热榜速报】"))[0] || "";
      c = hbLine ? `${hbLine}\n${c.slice(sv)}` : c.slice(sv);
    } else {
      c = c.slice(sv);
    }
  }
  if (
    c.includes("直接相关的切入") ||
    c.includes("特质衍生的切入") ||
    c.includes("相关领域的切入") ||
    c.includes("结合你选中的领域")
  )
    return c;
  c = c.replace(
    /(?:需要的话[^\n。]{0,40})?这些方向同样可以让我深挖资料或直接写稿[。．.！!～~]*\s*$/,
    ""
  );
  return c.trimEnd();
}

// 稀疏改道（单领域今日命中≤3 → 话题速览）正文清洗：模型虽被明确告知"今日热榜已由系统
// 置顶、严禁私发热榜列表"，但只要它在工具循环里拿到过热榜数据，仍会无视结构指令，把全榜
// 条目自行编号、私挂【领域】标签倒在分隔线下方（2026-09 实测：女性主义速览下私挂23条
// 大国基建/赛果/讣告等垃圾）。置顶 entityHotBlock 是今日热榜的【唯一权威出口】，这里确定性
// 剥掉模型私写的榜单行：特征="序号 + 平台｜标题 + 【领域标签】"（与前端热榜条目契约同形）。
// 不会误伤「相关领域的切入」里的胶囊——那是"纯文字条目 行尾【领域】"，不带"平台｜"。
export function stripModelHotList(c: string, tags: string[]): string {
  const tagAlt = tags
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!tagAlt) return c;
  // 编号可有可无；行内含全角/半角竖线且带本次领域标签胶囊 → 判定为私发热榜条目。
  const taggedItem = new RegExp(
    `^\\s*\\d+[\\.、]?\\s*.*[｜|].*【(?:${tagAlt})】`
  );
  // 2026-09 图2实锤补漏：模型会整体仿冒确定性领域榜的【平台分节】格式——
  // "🔥 微博 今日热点\n1. 某标题 【女性主义】"（条目无｜竖线，旧正则只剥带｜的，
  // 整段假榜漏网，与系统顶部"今日0命中"灰条自相矛盾）。分节行与其下的标签序号行都剥。
  const platformSection =
    /^\s*🔥?\s*\S.{0,10}?\s*(?:今日热点|今日热榜)\s*$/;
  const taggedNumberedItem = new RegExp(
    `^\\s*\\d+[.、)]\\s+.*【(?:${tagAlt})】`
  );
  // 私发榜单常见的开头/收尾说明行（含模型自编的"其余平台…暂无…由系统补充"串场句）。
  const hotListNote =
    /今日各平台.{0,12}热榜|按各平台原始热度|实时热榜中与|筛选出以下相关热点|逐条筛选|由系统补充|其余平台|以下为近\s*3?0?\s*天相关内容/;
  let inFakeSection = false;
  const kept: string[] = [];
  for (const ln of c.split("\n")) {
    const trimmed = ln.trim();
    // 进入/退出私仿平台分节区：分节头开启；遇到速览结构标题等非榜单正文行时关闭。
    if (platformSection.test(trimmed)) {
      inFakeSection = true;
      continue;
    }
    if (
      inFakeSection &&
      trimmed &&
      !taggedNumberedItem.test(ln) &&
      !taggedItem.test(ln)
    ) {
      inFakeSection = false;
    }
    // 分节区内的标签序号行（吞掉；区内空行也吞，避免成片空行）
    if (inFakeSection && (taggedNumberedItem.test(ln) || !trimmed)) continue;
    if (taggedItem.test(ln)) continue;
    // 分节区外、无竖线但带本次领域标签的数字序号行同样是私榜条目
    if (!inFakeSection && taggedNumberedItem.test(ln)) continue;
    if (
      hotListNote.test(ln) &&
      !/【主体速览】|直接相关的切入|相关领域的切入/.test(ln)
    )
      continue;
    kept.push(ln);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .trimEnd();
}

// 附带兴趣区（A6）：用户在抓热点消息里顺带点名、但未接管主领域的话题（如"关注一下量子计算突破"），
// 主榜单之后追加「🔗 关于X」小节：对本轮已抓的当日条目做语义相关性匹配（复用 tagTopicsByDomains 同一套判定），
// 命中的按"序号. 平台｜标题 【X】"列出（可挂"查看详情"）；一条没命中就给一行提示，绝不编造。
// 在 finalizeFallback（含领域白名单清洗）之后追加，避免【X】标签被白名单当成"非所选领域"删掉。
async function renderAuxTopicsSection(
  auxTopics: string[],
  fetchedByPlatform: Map<string, any[]>
): Promise<string> {
  const topics = (auxTopics || [])
    .map((t) => (t || "").toString().trim())
    .filter((t) => t.length >= 2);
  if (!topics.length) return "";
  const all: { platform: string; title: string }[] = [];
  for (const [platform, arr] of fetchedByPlatform) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      const title = (t?.title || t?.word || t?.name || "").toString().trim();
      if (title) all.push({ platform, title });
    }
  }
  if (!all.length) return "";
  const tagsByIndex = await tagTopicsByDomains(all, topics, {});
  const blocks: string[] = [];
  for (const tp of topics) {
    const hits = all
      .map((it, idx) => ({ it, tags: tagsByIndex.get(idx) }))
      .filter(({ tags }) => (tags || []).includes(tp))
      .slice(0, 10);
    if (!hits.length) {
      blocks.push(
        `🔗 关于「${tp}」\n今日各平台热榜暂无「${tp}」直接相关的热点。想深挖这个主题的背景资料或直接出内容，直接说"深挖${tp}"即可。`
      );
      continue;
    }
    const lines = hits.map(
      ({ it }, i) => `${i + 1}. ${it.platform}｜${it.title} 【${tp}】`
    );
    blocks.push(`🔗 关于「${tp}」\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

// 主体 × 今日热榜对照（2026-09）：用户点名一个具体主体（如"zont1x""487"）时，主流路径
// 应是"先拿今日各平台热榜做对照"，而不是直接给主体速览。这里确定性地把主体与当日全量
// 热榜标题做语义匹配（复用 tagTopicsByDomains/matchTodayTopics 同一判定），产出置顶块：
//   · 0 命中 → 一行【热榜速报】说明今日热榜暂无该主体、已按全网资料整理（前端渲染为居中
//     灰条），再加分隔线，下方接模型的【主体速览】结构；
//   · 1-2 条（结果较少）→ 先列命中的热榜条目（"序号. 平台｜标题"，前端可挂查看详情），
//     再一行【热榜速报】说明"结果较少、已按全网资料补充"，分隔线后接速览；
//   · ≥3 条（主体正在热榜）→ 列出命中条目 + 分隔线，再接速览。
// 阈值 FEW_MAX=2：匹配数 ≤2 视为"较少"。匹配失败/热榜抓取失败一律返回空串（静默降级为
// 原来的纯速览，不影响主链路）。
const ENTITY_HOT_FEW_MAX = 2;
const ENTITY_HOT_DIVIDER = "────────────";
function buildEntityHotBlock(
  subject: string,
  hits: { platform: string; title: string }[]
): string {
  const s = (subject || "").trim();
  if (!s) return "";
  const items = hits.slice(0, 5);
  if (items.length === 0) {
    return `【热榜速报】今日各平台热榜暂无「${s}」相关热点，已按全网资料为你整理相关内容\n${ENTITY_HOT_DIVIDER}`;
  }
  const lines = items.map(
    (it, i) => `${i + 1}. ${it.platform}｜${it.title}`
  );
  if (items.length <= ENTITY_HOT_FEW_MAX) {
    return `🔥 今日热榜相关\n${lines.join(
      "\n"
    )}\n【热榜速报】今日热榜与「${s}」直接相关的结果较少，已按全网资料为你补充更多内容\n${ENTITY_HOT_DIVIDER}`;
  }
  return `🔥 今日热榜相关\n${lines.join("\n")}\n${ENTITY_HOT_DIVIDER}`;
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
  // 阶段3 故障可视化：全源失败的平台末尾提示，不再静默消失。
  const notices: string[] = [];
  for (const [platform, topics] of fetchedByPlatform) {
    if (!Array.isArray(topics)) continue;
    for (const t of topics) {
      const title = (t?.title || t?.word || t?.name || "").toString().trim();
      if (title) all.push({ platform, title });
    }
    if (topics.length > 0 && topics[0]?.error) {
      notices.push(`⚠️ ${platform}：${topics[0].error}`);
    }
  }
  if (all.length === 0 && notices.length === 0) return "";

  // 逐个领域并行判断命中，得到 下标 -> 命中领域标签集合。
  const tagsByIndex = await tagTopicsByDomains(all, domainList, userGlossary);

  // 汇总输出：只输出至少命中一个领域的热点，按平台聚合分节（每节内重新 1-N 编号）。
  const lines: string[] = [];
  const sections: { platform: string; items: string[] }[] = [];
  const secIdx = new Map<string, number>();
  all.forEach((it, idx) => {
    const tags = tagsByIndex.get(idx);
    if (!tags || tags.length === 0) return;
    const tagStr = tags.map((t) => `【${t}】`).join("");
    let si = secIdx.get(it.platform);
    if (si === undefined) {
      si = sections.length;
      secIdx.set(it.platform, si);
      sections.push({ platform: it.platform, items: [] });
    }
    sections[si].items.push(
      `${sections[si].items.length + 1}. ${it.title} ${tagStr}`
    );
  });
  for (const s of sections) {
    lines.push(`🔥 ${s.platform} 今日热点`);
    lines.push(...s.items);
  }
  // 全部领域今日都 0 命中 → 返回空正文，让上层用一句说明 + finalizeFallback 走近30天兜底。
  // （若此时有平台源故障提示，先带上提示，避免用户以为纯粹是"没热点"。）
  if (lines.length === 0) {
    return notices.length ? notices.join("\n") : "";
  }
  const header = `已从各平台抓取今日实时热榜，并按所选领域（${domainList.join(
    " / "
  )}）筛选出以下相关热点（按平台聚合，各平台内按热度排列）：`;
  const tail = notices.length ? `\n\n${notices.join("\n")}` : "";
  return `${header}\n\n${lines.join("\n")}${tail}`;
}

// 今日命中稀疏补挂（2026-09 评测实证）：领域筛选当日仅 1-2 条命中时（如「女性成长」当日
// 全榜只有 1 条直接相关），用户只看到一条干巴巴标题、无内容可做。此时主动追加近期检索内容
// 作为补充——与"0 命中走近30天兜底"同一数据源（findRecentByDomain），口径一致、零新增依赖。
// 0 命中（返回空串/提示）不处理，交给上层 finalizeFallback；≥3 条不补，保持今日榜主体。
async function supplementSparseToday(
  deterministic: string,
  domainList: string[],
  userGlossary: Record<string, string>,
  pushRefs?: (items: { title?: string; url?: string; source?: string; published?: string }[]) => void
): Promise<string> {
  const todayCount = (deterministic.match(/^\s*\d+[.、)]/gm) || []).length;
  if (todayCount === 0 || todayCount >= 3) return deterministic;
  const sup: { title: string; url: string; source: string; published?: string }[] = [];
  const seen = new Set<string>();
  for (const d of domainList) {
    try {
      const items = await findRecentByDomain(d, 6, userGlossary?.[d] || "");
      for (const it of items) {
        if (it.title && !seen.has(it.title)) {
          seen.add(it.title);
          sup.push(it);
        }
      }
    } catch (e) {
      console.warn(`[chat] 今日榜稀疏补全：领域「${d}」近30天兜底检索失败，跳过:`, (e as Error)?.message || e);
    }
  }
  if (!sup.length) return deterministic;
  // 补挂链接统一交给调用方收进 refs 响应字段（前端第一层回复下的折叠参考块）
  pushRefs?.(sup);
  const lines = sup.slice(0, 6).map((it, i) => {
    const date = it.published ? `[${String(it.published).slice(0, 10)}] ` : "";
    return `${i + 1}. ${date}${it.source}｜${it.title}`;
  });
  return `${deterministic}\n\n---\n📌 今日该领域直接相关热点较少，以下是近期检索到的相关内容（非今日实时热榜，仅供参考）：\n\n${lines.join("\n")}`;
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
  // 平台分节头（"🔥 平台名 …"）下若无任何条目行（该节条目被过滤光）→ 删除空节头
  const isSec = (l: string) => /^🔥\s*\S/.test(l);
  const isNum = (l: string) => /^\s*\d+[.、)]/.test(l);
  const cleaned: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (isSec(out[i])) {
      let hasItem = false;
      for (let j = i + 1; j < out.length; j++) {
        if (isSec(out[j])) break;
        if (isNum(out[j])) {
          hasItem = true;
          break;
        }
      }
      if (!hasItem) continue;
    }
    cleaned.push(out[i]);
  }
  return cleaned.join("\n");
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
): Promise<{
  content: string;
  emptyNote: string | null;
  refs: { title: string; url: string; source: string; published?: string }[];
}> {
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
      return { content: result, emptyNote: note, refs: fb?.items ?? [] };
    }
    return {
      content: `${result}\n\n（${note}）`,
      emptyNote: null,
      refs: fb?.items ?? [],
    };
  }
  return { content: result, emptyNote: null, refs: fb?.items ?? [] };
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
- ✅ 直接相关就保留，不硬扯：一条热点的核心当事人/核心事件/核心议题，【一步联想】就能到「${domain}」（当事人就是该领域关心的人群、事件就是该领域议题），就【保留并展示】；标题【主语】本身就是该领域的具体当事人（如领域「女性主义」里"女生/女子/女大学生/宝妈"做主语、事件就是她本人处境或待遇的社会新闻）同样算直接相关，保留；需要绕两个弯以上才沾边的（例如"奶奶也是女性所以工程事故算女性议题""员工里可能有女性所以工厂管理算女性议题"）属于硬扯，不要列出；顺带提到、主体内容无关的也不列。拿不准时问自己：关注该领域的人会觉得这条是他关心的吗？答案否定的剔除——但【主语就是该领域当事人】的事件不属于硬扯，不要把这条也剔掉。
- ✅ 保留真正相关的，删掉硬扯的：不要因为"不够典型"就删【直接相关】的边缘细分话题；但也绝不要把需要拐弯才沾边的内容塞进来。
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
【基础身份·先于下面一切规则】你同时也是一个见多识广的 AI 助手：用户聊到任何人物/事件/常识/问答时，先用你的通用知识正常回应——【禁止】以"无法获取信息""请提供更多上下文""我是AI助手无法…"这类话拒答；确实不知道的细节就如实说明知道什么、不知道什么。⚠️【事实防编造】涉及具体人物/战队/俱乐部/公司/作品的归属、身份、头衔、数据、近期动态这类容易记错的事实细节：【必须先调用 search_web_fact 工具联网核实，再依据检索结果回答】；检索结果与你的记忆冲突时，一律以检索结果为准；检索不到可靠结果就明确说"这个我不确定/可能已过时"，【严禁】编造精确归属或张冠李戴（比如把选手说成别的战队、把作品说成别的作者）。
- 📎【引用来源纪律】回复中给出的任何参考来源/链接，【只能】来自本次检索结果里真实返回的 URL（search_web_fact 等工具结果里的 source/url 字段），【严禁】凭记忆拼凑域名、或只给网站首页冒充原文链接（如拿 investor.nvidia.com 首页充当财报原文）；只看到摘要、没打开过原文的来源，要如实说明"仅见摘要，原文未核实"；用户追问某条来源的原文内容时，依据检索结果里该条的实际内容回答，检索结果里没有就承认并立即重新检索，【严禁】编造"原文说…"。
- 🔍【外号/昵称/黑话指称查询的专属纪律】用户问"X是谁/X什么意思/X是什么梗"（X 通常是外号、谐音梗、缩写、黑话）时：① 这是对 X 本身的【独立指称查询】——search_web_fact 的检索词必须围绕 X 本身（如"X 是谁""X 是什么意思""X 外号/昵称/梗"+从上文判断出的圈子词，如游戏名/项目名/领域名）；【严禁】把上一轮聊的具体主体人名拼进检索词（上文在聊人物A时，不许搜"X A"），上文语境只用来判断圈子，不用来替代对 X 的检索；② 归属判定必须有【明确释义句】——资料里出现"X 是 Y 的外号/昵称/黑话""Y 被称为 X""X 指的是 Y"这类直接定义，才能写"X=Y"；仅凭 X 和另一个名字在同一篇帖子里高频共现【绝对不能】判定归属（对比/拉踩帖"A 和 B 谁强""巅峰期 A＞B"里 A、B 是两个不同的人，严禁把外号读反、严禁把 X 安给被比较的另一方）；③ 同一个称呼在不同圈子可能指完全不同的对象（电竞、球类、说唱、饭圈、国足等各圈都有内部外号体系，跨圈撞名常见），按用户语境选定并说明圈子前提；若资料里归属说法矛盾、或只有共现没有释义句，直接说"这一称呼的归属资料不足/存在争议"并列出候选，【严禁】挑一个共现最多的人硬安。只有当用户要求抓取热榜/找选题时，才执行下面的热点规则。
${
  domain
    ? `\n🔒【领域锁定 = 最高优先级，凌驾于用户本次说法之上】用户已在界面锁定创作领域「${domain}」。这是一个持续生效的【相关度筛子】：无论用户这次说的是"抓取热点""抓今日热点""全量热榜""原始热点"还是任何类似说法，你最终展示的内容都【必须】围绕「${domain}」组织——核心当事人/核心议题一步就能联想到该领域的都保留，需要绕两个弯以上才沾边的硬扯内容（"奶奶也是女性""员工里可能有女性"式）不列出；保留下来的按各平台原始热度从高到低排列。抓取阶段照常抓全量。【不要】把【直接相关】的边缘细分内容删掉，也【不要】写逐条分析的过程文字；但也【不要】因为用户说了"抓取/全量/原始"就把需要拐弯才沾边、甚至完全无关的内容也堆进来。\n- ⚠️【当前领域集合是唯一权威，以本条为准】本次锁定的领域【完整清单】就是：${domainList.map((d) => `「${d}」`).join("、")}，共 ${domainList.length} 个。用户随时可能在界面上增删领域，所以【对话历史里出现过的领域组合可能已经过期】。你【必须】以本条系统提示里的这份清单为准，对清单里的【每一个】领域都主动去抓取、归类、排序——包括刚新增的领域。绝对不要沿用你之前回复里用过的旧领域集合。\n- ⚠️【每次抓取都要真跑，禁止偷懒复用】只要用户要求抓取/刷新/再来一次，你就【必须】重新调用 fetch_hot_topics 并按当前完整领域清单重新排序，输出全新结果。【严禁】回复"无变化""仍是N条""数据没更新""内容重复""与其让你等待"这类话，也【严禁】直接把上一轮的列表原样再贴一遍——因为用户很可能刚改动了所选领域，"无变化"几乎一定是错的。\n- 🆕【今日完全没有沾边热点的领域，只写一句说明，剩下交给系统】对本次锁定的【每一个】领域，你都要在各平台今日实时热榜里把沾边的热点排进来并打上【领域】标签。如果某个领域【连沾边的都一条都没有】（尤其是小众/垂直领域，如「反bl」「原生家庭」「bg与bl大战」），你【只需】在正文里对该领域用一句话说明"今日各平台实时热榜暂无「该领域」相关热点，以下为近30天相关内容"，然后【就停在这里】——【不要】自己去调 search_recent_topics_by_domain、【不要】自己罗列任何近30天条目、也【不要】编造"经检索暂无""近期无引爆公共讨论的热点"之类结论草草收尾。系统会【自动检测】哪些领域今日没有任何带标签条目，并【自动为其检索近30天内容追加到回复末尾】，你自己写条目只会和系统追加的内容重复。\n- 🧭【方向建议必须分区输出，两个小节标题必须逐字使用、不得改写】用户在聊天里抛出一个具体主题/人物/事件时（无论他是想要内容方向、还是只是随口一问/纯问答，只要不是要求抓热榜），你都要：先回应用户的问题本身（如有），再给出分两区的方向建议，缺一不可：\n  ⚠️ 用户在问判断/建议类问题时（如"值得做内容吗""怎么看""该不该做""还能不能入局""适不适合做"），开头必须先用 2-4 句给出【明确判断和理由】（值不值得/为什么/机会点和风险在哪），结合实时检索到的事实说，不要打太极；然后再给两区方向——严禁跳过判断直接甩方向列表。\n  第一区标题用「直接相关的切入」：不受领域约束，围绕这个主题本身最直接可做的 2-3 个切入方向（这是优先级最高的一区，窄范围直接相关的切入永远排最前），这些行【不要】打【】胶囊；【必须就着该主题本身给切入，严禁把第一区写成"跳出该主题/换赛道/跳出领域"之类让用户离开原话题的内容——用户点名这个主题，就要先答这个主题本身】；\n  第二区标题用「相关领域的切入」：先判断这个主题本身所属或强相关的领域（自行判断，【不受右上角所选领域限制】，如 zont1x→电竞、Cursor→AI编程工具、村超→体育/乡村旅游），再给 2-3 个从这些相关领域视角出发的切入方向，每条独占一行、行尾用独立的【相关领域名】胶囊标注（如【电竞】）；右上角锁定的领域如果恰好与主题真相关，也可以列进去；不要硬凑不相关的领域；\n  条目行内严禁 emoji/图标装饰（如🔥💰⚡）；两区都给才是合格回答，只给其中一区算答错。结尾补一句“这些方向同样可以让我深挖资料或直接写稿”。\n`
    : `\n🔓【用户已清空所有创作领域 = 最高优先级，凌驾于对话历史之上】用户当前在界面上【没有选择任何创作领域】。这条以本条系统提示为准：无论对话历史里之前是否锁定过某个领域（例如「女性成长」或任何其它领域），那份锁定【现在已经全部失效、作废】——因为用户已经把所有领域都取消了。你【绝对不要】再按任何历史领域去筛选、剔除或重排热点，也【绝对不要】沿用上一轮回复里针对某个领域的筛选结果。\n- ✅ 你【必须】列出各平台抓到的【全部】热点，按各平台榜单原始热度顺序展示，【不做任何领域筛选、不做剔除、不加 ⭐ 相关度标记、不做重排】。\n- ✅ 每一条热点后面用【】标注它所属的创作领域标签（可多标），标签自由从常见领域集合里选取，而不是局限在任何历史锁定过的领域。\n- ⚠️ 只要用户要求抓取/刷新，你就【必须】重新调用 fetch_hot_topics 并输出全量带标签结果，【严禁】回复"无变化""与上次相同"或原样复用上一轮列表。\n- 🧭【方向建议分区输出（未锁领域版），小节标题必须逐字使用、不得改写】用户在聊天里抛出具体主题/人物/事件时（非抓热榜请求）：先回应问题本身——用户在问判断/建议类问题时（如"值得做内容吗""怎么看""该不该做""适不适合"），开头必须先用 2-4 句给出明确判断和理由（结合实时检索到的事实，不要打太极），严禁跳过判断直接甩方向列表；再输出标题行「直接相关的切入」，下面给 2-3 个围绕该主题本身最直接可做的切入方向（窄范围直接相关的切入优先级最高；【严禁】写成"跳出该主题/换赛道"之类让用户离开原话题的内容），每条独占一行（不打【】胶囊）；再输出标题行「相关领域的切入」，先判断这个主题本身所属或强相关的领域（自行判断，【不受右上角所选领域限制】，如 zont1x→电竞、Cursor→AI编程工具、村超→体育/乡村旅游），再给 2-3 个从这些相关领域视角出发的切入方向，每条独占一行、行尾用独立的【相关领域名】胶囊标注（如【电竞】）；不要硬凑不相关的领域；条目行内严禁 emoji/图标装饰（如🔥💰⚡）；结尾补一句"这些方向同样可以让我深挖资料或直接写稿"；【禁止】反问澄清来拖延、禁止只回"说'抓热点'我帮你抓"这类空指引。\n`
}
你的能力：
1. fetch_hot_topics: 从${Object.keys(PLATFORM_FETCHERS).join("、")}抓取实时热点
2. filter_hot_by_domain: 用 AI 判断哪些热点和用户领域相关
3. generate_video_script: 根据热点生成可直接照读的短视频口播稿；用户给了观点判断就走观点评论稿（原话原样传 plot，不许替用户中立化），用户指定时长就传 duration+wordRange
4. search_recent_topics_by_domain: 小众/垂直领域今日实时热榜无相关热点时，检索该领域近30天内容做兜底

工作流程：
- 用户说"抓热点"时，依次调用各平台的 fetch_hot_topics${
    domain ? "；抓完后保留和锁定领域沾边的（只丢完全无关的），按各平台原始热度从高到低展示，不要写逐条分析过程" : ""
  }
- 用户说"筛选"或"相关"时，调用 filter_hot_by_domain，从用户消息中推断领域
- 用户说"生成脚本"或"写脚本"时，调用 generate_video_script；用户消息里带的观点/判断原话必须原样放进 plot（不许概括成中性提纲），用户说了时长（30秒/1分钟/3分钟等）必须同时传 duration 和 wordRange（按每秒约4.5字换算，如3分钟=540-660字）
- 你也可以自主判断，一次性完成 抓取→筛选→生成 的完整流程

${displayRule}

⚠️【展示格式硬性要求，必须遵守】
- 展示热点列表时，【禁止使用 Markdown 表格】（即禁止出现 | 平台 | 热点 | 标签 | 这种竖线表格）。前端无法把表格里的标签正确渲染成独立胶囊，也无法挂载"查看详情"按钮。
- 每一条热点【必须独占一行】，格式固定为："序号. 平台｜标题 【标签1】【标签2】"，例如：1. 知乎｜某条热点标题 【女性成长】。
- 每个领域标签都要用【独立的】书名号，一个领域一个【】，绝对不能写成【女性成长、反bl】这种粘在一起的形式；正确是【女性成长】【反bl】。
- 绝大多数热点只属于其中一个领域，逐条独立判断，不要给每条都打上完全相同的一组标签。

回复使用中文，格式清晰；列表条目（热点列表条目、方向建议的"- "条目）行内【禁止】加任何 emoji/图标装饰（如 🔥💰⚡⭐），emoji 只可用在段落式叙述里。`;
}

// ========== Tool Execution ==========

// AI 腔黑名单清除（2026-09 与 /api/script 出口对齐）：聊天内任务轮直接产出的脚本/文案
// 此前不做出口清理，"你发现没/说白了"等口头禅照样泄漏。只抹引导语本身，不动句子主体。
const cleanAiTics = (s: string) =>
  s
    .replace(
      /你有没有发现|你发现没(有)?|但你以为这就完了[??]?|听懂没[??]?|注意到了吗[??]?|说白了|我告诉你/g,
      ""
    )
    .replace(/([，,：:]){2,}/g, "$1")
    .replace(/^[，,。.\s]+/, "");

async function executeTool(
  name: string,
  args: any,
  domain: string,
  userGlossary: Record<string, string> = {},
  factSink: string[] = [],
  // 本轮全网搜索链接收集器：search_web_fact / 近30天兜底 / 脚本事实核实命中的链接
  // 统一推入，最终随响应 refs 返回前端第一层回复下的折叠参考块
  pushRefs?: (
    items: { title?: string; url?: string; source?: string; published?: string }[]
  ) => void
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
      const userPlot = (args.plot || "").toString().trim();
      const durationTxt = (args.duration || "").toString().trim();
      const wordRangeTxt = (args.wordRange || "").toString().trim();
      // 时长档位（与 /api/script 同口径：中位字数为目标）；未指定时观点稿默认约500字、
      // 资讯稿 300-500 字。聊天出口不做二次压缩，靠明确目标字数+硬上限约束直达。
      const wr = wordRangeTxt.match(/(\d+)\s*[-~至到]\s*(\d+)/);
      const rangeLow = wr ? Number(wr[1]) : 0;
      const rangeHigh = wr ? Number(wr[2]) : 0;
      const midWords = wr ? Math.round((rangeLow + rangeHigh) / 2) : 0;
      const capWords = rangeHigh
        ? Math.ceil(rangeHigh * (rangeHigh <= 150 ? 1.12 : 1.1))
        : 0;
      const reqSec = (() => {
        const m = durationTxt.match(/(\d+)\s*分/);
        const s = durationTxt.match(/(\d+)\s*秒/);
        return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
      })();
      // 并行：模板召回（结构）+ RAG 原文（语感）+ 意图分类（观点/资讯）。
      // 三条都失败不得阻塞写稿，各自静默降级。
      const ragQuery = `${(args.topic || "").toString().trim()} ${userPlot}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      const [samples, ragHits, intent] = await Promise.all([
        pickRelevantTemplates(args.topic, scriptDomain, 5, plainLLM),
        ragQuery.length >= 4
          ? retrieveVoiceCorpus(ragQuery, { topK: 3, minScore: 0.35 }).catch(() => [])
          : Promise.resolve([]),
        userPlot
          ? classifyScriptIntent({ plot: userPlot }, plainLLM)
          : Promise.resolve({ mode: "info" as const, thesis: "", embedBits: [] }),
      ]);
      const isOpinion = intent.mode === "opinion";
      const longForm = (midWords ? Math.round(midWords / 4.5) : reqSec) >= 85;
      const outlineBlock = samples.length
        ? `\n\n以下是最贴话题的2条真实爆款结构拆解（只学结构套路，不要照抄内容与措辞）：\n\n${renderTemplateOutlines(samples.slice(0, 2))}`
        : "";
      const voiceBlock = (() => {
        const ex = renderExcerpts(samples);
        return ex
          ? `\n\n以下是真实爆款口播的原文片段——语感主要从这里学：口语措辞、节奏、梗的用法（忽略语音转写错别字）；严禁照抄其中具体内容与句子：\n\n${ex}`
          : "";
      })();
      const ragBlock = ragHits.length ? `\n\n${formatKnowledge(ragHits)}` : "";
      // 事实依据预取：脚本里可能写到具体主体（人物/战队/公司/作品）的归属、头衔、数据，
      // 必须联网核实，禁止凭模型记忆写事实细节（与 entity 预取同源的兜底）
      let factBlock = "";
      try {
        const tq = (args.topic || "").toString().trim().slice(0, 40);
        if (tq) {
          const factItems = await searxRecentSearch(tq, 8, "", true);
          // 脚本事实核实链接同样收进本轮参考来源
          pushRefs?.(factItems);
          const factLines = factItems
            .map((it, i) => `【来源${i + 1}｜${it.source || ""}】${(it.title || "").trim()}｜${(it.content || "").trim()}`.trim())
            .filter((s) => s.length > 6);
          if (factLines.length) {
            // 资料收集器（2026-09）：同一批资料喂给年龄守卫，成稿出口做确定性年龄修正
            factSink.push(...factLines);
            // 信任级标注（2026-09 链路审计）：这里拿到的只是搜索结果的【标题+短摘要】，
            // 不是文章原文，必须明说，防止模型把摘要里可能被截断/转述失真的数字引语当原文。
            factBlock = `\n\n【事实依据·必须遵守】以下是该话题的联网搜索结果（标题与短摘要，非文章原文）。脚本中涉及具体人物/战队/公司/作品的身份、归属、头衔、数据、近期动态时，【只能】写下面资料支撑的内容；资料与你的记忆冲突时以资料为准；资料没有的细节宁可不写，【严禁】编造或张冠李戴；摘要里没写全的数字/引语不许自行补全。时效基准：今天是 ${new Date().toISOString().slice(0, 10)}，"现状/年龄/头衔/近期动态"一律以资料中【最新进展】为准，旧状态只能写成过去式背景，严禁把已被新进展取代的旧状态当现状；人物当前年龄资料里有出生日期才写具体年龄，没有就不写具体年龄数字：\n${factLines.join("\n")}`;
          }
        }
      } catch (e) {
        console.warn(`[chat] 脚本生成的事实预取失败（话题=${(args.topic || "").toString().slice(0, 40)}），无资料继续生成:`, (e as Error)?.message || e);
      }
      const lengthLine = midWords
        ? `全稿口播文字（含标点）约 ${midWords} 字左右${
            isOpinion && capWords ? `，${capWords} 字是绝对上限（一个字都不能超）` : ""
          }；${
            isOpinion
              ? "这是观点评论稿，篇幅靠论证层次撑足，严禁以资料少为由自行缩短；不许换说法重复凑字数"
              : "放得下就多保留信息点，明显放不下就只留最值得讲的2-3个点，严禁兑水"
          }。`
        : isOpinion
          ? "全稿口播文字约 500 字左右，靠论证层次撑足，不要写成提纲。"
          : "字数控制在 300-500 字，信息密集不兑水。";
      const scriptPrompt = isOpinion
        ? `你是靠"观点锐评"涨粉的头部短视频口播博主。观众刷到你，不是来听新闻复述，是来听你把一个有争议的判断掰开揉碎讲透。请基于【用户给出的中心论点】，写一篇可以直接对着镜头讲的观点评论口播稿。

【本条视频的中心论点·用户原话】
「${intent.thesis || userPlot}」
论点原义必须完整保留，【严禁】稀释、偷换、改温和、和稀泥写成"一方面…另一方面…"。

【由头事件】「${args.topic}」
【论据库】（资料是你论证的弹药，不是要你播报的内容）
${factBlock}${outlineBlock}${voiceBlock}${ragBlock}

按以下结构写（${
            longForm ? "五个部分一个都不能省" : "短稿可把第4部分并入第3部分"
          }；整篇直接成段口播，2-4个自然段，不要小标题、序号或分镜提示）：
1. 开头3秒：直接甩判断或反常识断言，第一句≤20字。严禁自我介绍、"今天聊聊"、"先问大家一个问题"。${HOOK_QUOTE_RULE}。
2. 立靶子：先讲清流行看法或对立面怎么说，再亮出中心论点——冲突本身就是留人点。
3. 递进论证（占全稿一半以上篇幅）：${
            longForm ? "3" : "2"
          }个分论点层层推进（现象→原因→本质或推演，顺序不能互换）；每个分论点"一句小论点开头 → 论证 → 一句点题"；举例、因果推演、反问、对比、生活类比五种手法至少用到三种；每个抽象判断后立刻跟具体落点。
4. 反方最强版本与反驳：替反对者把最有道理的那句话讲出来，先承认其中对的部分，再划清不同意的地方。
5. 收尾：一句能截图传播的金句回扣论点，再抛一个贴着这件事的具体二选一反问。

【素材使用纪律】
- 资料只取与当前分论点有关的一个细节、数字或心态，用"有人算过一笔账""一个高赞回答的逻辑是""网上有种说法"模糊化转述；【严禁】"X月X日某平台有个帖子说……后来又有个回答说……"按时间报幕；每用一次素材后面必须接你自己的分析，引完必评。
- 因果推演、群体心理分析、生活类比、反方假设、逻辑反驳允许而且必须写足；但硬事实（数字/日期/人名机构名/原话）资料里没有一个字不许编。
${OPINION_FACT_BOUNDARY}
- 批评现象与心理机制，不给身份群体扣侮辱性帽子、不攻击持观点的人；不造谣不挑动对立。

【口语】全篇对着一个具体的"你"讲话，短句为主、长短交错；按自然段成段，不许一句一行。${ANTI_AI_RULES}
风格：${args.style || "观点锐评口播"}
${lengthLine}
直接输出口播正文，不要任何解释、前言、标题或"以下是"之类的话。`
        : `你是资深短视频编导。请结合下面的热点事件与核实资料，生成一个可直接对镜头照读的口播稿。

话题：「${args.topic}」
领域：${scriptDomain}
风格：${args.style || "口播知识分享"}
${factBlock}${outlineBlock}${voiceBlock}${ragBlock}
${userPlot ? `\n参考梗概（保留其核心创意与走向，在此基础上展开）：\n${userPlot}` : ""}

要求：
1. 第一句必须是事件里具体的事实、原话或数字，整句≤20字、3秒出头念完，背景第二句再补；严禁自我介绍与"今天给大家聊聊"；${HOOK_QUOTE_RULE}；
2. 结构：钩子（1句）→ 价值主体（占七成，按信息点推进，两三句一个转折或新信息，${
            reqSec >= 85 ? "约一半处用一个资料里真实有的转折/加码做二次钩子，" : ""
          }不要平铺）→ 收束（只保留一个动作，取自资料真实争议/反差/悬念，没有争议就用事实收尾）；
${INFO_NARRATIVE_RULE}
4. 【事实纪律】${infoFactDiscipline()}；
5. 全篇短句口语化、成段输出（2-4个自然段，严禁一句一行），像朋友饭桌上讲事，不像台上念稿；${ANTI_AI_RULES}
6. ${lengthLine}
直接输出口播正文，不要任何解释、前言、标题或"以下是"之类的话。`;
      let scriptRes = await callLLM([{ role: "user", content: scriptPrompt }], false);
      // 出口确定性守卫（2026-09 健身房伪引语案）：chat 写稿工具此前零后处理直接返回，
      // 模型把资料间接陈述改写成第一人称"原话"（"他让我公开道歉"）颠倒了冲突双方诉求。
      // 引语核对以本轮事实块+资料收集器为真相源；任何异常 fail-open 返回原稿。
      try {
        scriptRes = guardQuotes(scriptRes, [factBlock, ...factSink].join("\n")).text;
      } catch (e) {
        console.warn("[chat] guardQuotes failed, keep raw:", (e as Error)?.message || e);
      }
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
      // 近30天兜底链接收集在调用方做（要经过"领域是否允许"过滤，未选领域时模型拿旧领域
      // 乱调的结果不得进参考块）；本函数只返回数据
      return JSON.stringify(
        { domain: domains.join("、"), range: "近30天", realtime: false, items: merged },
        null,
        2
      );
    }
    case "search_web_fact": {
      const q = (args.query || "").toString().trim();
      if (!q) return JSON.stringify({ query: "", results: [] });
      // 事实核查不限时间范围（人物/战队资料不是新闻，旧资料同样有效）；
      // 带搜索摘要返回，模型才能据内容核实归属而非只看标题
      const items = await searxRecentSearch(q, 10, "", true);
      // 资料收集器（2026-09）：模型本轮核实过的资料留给成稿出口的年龄守卫用
      //（任务轮产出脚本/文案时，fixAgeClaims 靠这些资料里的出生日期修正过时年龄）
      const sinkLines = items
        .map(
          (it) =>
            `${(it.title || "").trim()}｜${(it.content || "").trim()}`.trim()
        )
        .filter((s) => s.length > 6);
      if (sinkLines.length) factSink.push(...sinkLines);
      // 本轮事实核实命中的链接收进参考来源（前端第一层回复下的折叠参考块）
      pushRefs?.(items);
      return JSON.stringify(
        {
          query: q,
          results: items.map((it) => ({
            title: it.title,
            snippet: it.content || "",
            source: it.source,
            url: it.url,
          })),
          note: items.length
            ? "以上为真实检索结果，请依据结果回答；与你的记忆冲突时以检索结果为准"
            : "未检索到相关结果，此时必须如实说明不确定，禁止编造",
        },
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
  useTools: boolean = true,
  temperature?: number
): Promise<any> {
  // 配置按请求解析（用户自带 Key > 系统默认 DeepSeek），见 lib/llm.ts
  const llm = getLlm();
  const body: any = {
    model: llm.model,
    messages,
  };
  // 分类/判定类调用显式传 temperature=0：热榜领域筛选这类确定性任务在默认
  // temperature=1.0 下同一条榜重复请求结果会飘（同一话题一次判中、一次判空）。
  if (temperature !== undefined) body.temperature = temperature;
  if (useTools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
  }
  // 全链路此前唯一无超时的上游调用：上游卡死会让请求永久挂起，用户端表现为
  // 一直"思考中"却永远等不到结果。deepseek 长结构化输出实测可达 ~90s，
  // 180s 硬超时只兜真挂死，不影响正常生成（含多轮工具循环）。
  // 走统一 llmChatJson：401/402/429 会抛带分类的 LlmApiError，顶层 catch 据此
  // 返回「配 Key / 去充值」引导，而不是让 undefined message 静默进入工具循环。
  const json = await llmChatJson(llm, body, 180000);
  if (!useTools) {
    return json.choices?.[0]?.message?.content || "";
  }
  return json.choices?.[0]?.message;
}
// ========== API Route Handler ==========

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      domain: rawDomain,
      platforms: rawPlatforms,
      glossary,
      allDomains,
      llm: rawLlm,
      _evalGround: rawEvalGround,
      // 上一轮结构邮戳（服务端上上轮回传、前端原样带回）：可信的结构化信号，
      // 替代从助手散文里正则猜"上一轮是热榜还是速览"。仅接受三个合法枚举值。
      lastTurnType: rawClientTurn,
    } = await req.json();
    // 绑定本请求的 LLM 配置：访客自带 Key 用访客的；系统内部调用（scheduler 带
    // X-Internal-Token）才用系统 env Key；外部访客没填 Key → 空 Key，下面立即拦截。
    setRequestLlm(resolveRequestLlm(rawLlm, isInternalRequest(req)));
    // 强制 BYOK：访客没填自己的 Key 直接返回 no_key 引导（必须早于意图分类器——
    // 分类器本身也要调模型）。顶层 catch 经 llmErrorAction 转成前端「配置 API Key」按钮。
    if (!getLlm().apiKey) {
      throw new LlmApiError("no_key", "访客请求未自带 API Key");
    }
    // 客户端可能漏传 domain/platforms（API 直调/旧缓存页面），undefined 会在
    // buildSystemPrompt 的 split/join 处炸成 500（已由线上栈日志证实）——入口统一收口。
    const domain = typeof rawDomain === "string" ? rawDomain : "";
    const platforms: string[] = Array.isArray(rawPlatforms)
      ? rawPlatforms.filter((p): p is string => typeof p === "string")
      : [];
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

    // ===== 意图感知路由（根治"领域锁定绑架所有对话"）=====
    // 三条输入通道的优先级：本轮消息里显式点名的领域 > 右上角领域选择 > 都没提 → 全量热榜。
    // 但领域逻辑只在本轮消息是【抓热点】请求时才生效；普通聊天/问答完全解绑，模型正常回答。
    const lastUserContent = (() => {
      const arr = Array.isArray(messages) ? messages : [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role === "user") return String(arr[i]?.content || "");
      }
      return "";
    })();
    // 意图判定统一走 lib/intent.ts 的 classifyTurn（2026-09 抽出）：LLM 分类器(temperature=0)
    // 是意图唯一权威 + subject/domains 逐字闸 + followup 跨主体结构闸；分类器挂掉只认强动作词
    // 兜底，弱话题词（很火/热门/大瓜）不触发抓榜。下方先准备它需要的上文输入。
    // 给意图分类器的上文线索：助手最近一条回复节选（让分类器能分辨"首次点名"与"追问中"）
    const lastAssistantExcerpt = (() => {
      const arr = Array.isArray(messages) ? messages : [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role === "assistant")
          return String(arr[i]?.content || "").replace(/\s+/g, " ").slice(0, 200);
      }
      return "";
    })();
    // 助手最近一条回复全文（供 lastTurnType 核验己方固定输出标记：主体速览 or 热榜 or 其他）
    const lastAssistantFull = (() => {
      const arr = Array.isArray(messages) ? messages : [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role === "assistant")
          return String(arr[i]?.content || "");
      }
      return "";
    })();
    // 上文历史全文（不含本轮用户消息）：分类器 followup 轮提取的 subject / prevSubject
    // 逐字校验用。
    const priorContextText = (() => {
      const arr = Array.isArray(messages) ? messages : [];
      let seenCurrent = false;
      const parts: string[] = [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role === "user" && !seenCurrent) {
          seenCurrent = true;
          continue;
        }
        parts.push(String(arr[i]?.content || ""));
      }
      return parts.join("\n");
    })();
    // 上一轮结构（服务端确定性判定，不靠猜措辞）：hotboard=助手刚回的是各平台热榜列表；
    // overview=助手刚回的是某主体的速览/多义解释；other=普通问答/产出；none=无上文。
    // 作为【结构化输入】喂给意图分类器，替代让分类器从上文原文里自己猜上下文类型。
    // 2026-09 起优先采信客户端原样带回的【上轮邮戳】（服务端自己上上轮签发，结构化可信）；
    // 邮戳缺失（API 直调/旧客户端）时才回退到"核验己方固定输出标记"的正则推断。
    const clientTurn: "hotboard" | "overview" | "other" | undefined =
      rawClientTurn === "hotboard" ||
      rawClientTurn === "overview" ||
      rawClientTurn === "other"
        ? rawClientTurn
        : undefined;
    const lastTurnType: "hotboard" | "overview" | "other" | "none" =
      !lastAssistantFull
        ? "none"
        : clientTurn ??
          (/已从各平台|今日各平台|实时热榜|热榜速报|按平台聚合/.test(
            lastAssistantFull
          )
            ? "hotboard"
            : /【主体速览】|直接相关的切入|并非单一指称|常见的是\s*[①1]/.test(
                lastAssistantFull
              )
              ? "overview"
              : "other");
    // 意图判定（分类器唯一权威 + 逐字闸 + 跨主体结构闸 + 强动作词兜底，全部在 lib/intent.ts）。
    // 本轮邮戳 turnType 随响应回传，下轮由客户端带回。
    const decision = await classifyTurn({
      lastUserContent,
      priorContextText,
      lastAssistantExcerpt,
      lastTurnType,
      domainUniverse: [...domainUniverse, ...Object.keys(userGlossary)],
      classify: (prompt) =>
        callLLM([{ role: "user", content: prompt }], false, 0),
    });
    let {
      isHotRequest,
      isTaskRequest,
      clsEntity,
      entityFollowup,
      chatSubject,
      subjectQualifier,
      msgDomains,
      auxTopics,
    } = decision;
    let turnTypeStamp = decision.turnType;
    if (!decision.clsOk)
      console.warn("[CHAT-CLS] 意图分类器不可用，本轮走强动作词兜底");
    // 各平台今日原始抓取：声明前置——单领域热榜的"稀疏→话题速览"前置判定要先抓一次，
    // 工具循环与两个确定性出口共用这份缓存，避免重复抓 8 平台。
    const fetchedByPlatform = new Map<string, any[]>();
    // 稀疏改道时已算好的"主体→今日命中"，主体预取的热榜对照直接复用、不再重复匹配。
    let sparseHitCache: {
      subject: string;
      hits: { platform: string; title: string }[];
    } | null = null;
    // 稀疏改道的源头禁令（见下方改道块赋值；conversationMessages 在其后才声明，故暂存）。
    let sparseBanContent: string | null = null;
    // 单领域抓热点·稀疏改道（2026-09 用户明确指定的结构）：
    // 用户选了/点名唯一一个领域要今日热点时，先确定性算今日全榜命中数：
    //  · 命中 ≤3 条（含 0 条）→ 今日榜单撑不起一份"热点列表"。此时【绝不】把全网搜到的
    //    网页文章直接当最终回复（旧行为：一堆裸链接、无结构、点不开），而是把该领域当成
    //    一个"话题主体"整体改走 entity 速览管线——顶部列今日命中条目（buildEntityHotBlock：
    //    0 条给"今日暂无"灰条、1-3 条列条目+结果较少说明），下方照常【主体速览】+
    //    「直接相关的切入」+「相关领域的切入」，检索到的网页只作幕后素材与折叠参考来源；
    //  · 命中 >3 条 → 今日内容充足，保持纯热榜速报。
    // 多领域（≥2）无法确定单一主体，不改道、保持原筛选+兜底。
    let sparseOverview = false;
    {
      const hotDomains = isHotRequest
        ? msgDomains.length
          ? msgDomains
          : currentDomainList
        : [];
      if (isHotRequest && hotDomains.length === 1) {
        const subject0 = hotDomains[0];
        try {
          const fbp =
            fetchedByPlatform.size > 0
              ? fetchedByPlatform
              : await fetchPlatformsHot(platforms);
          for (const [p, arr] of fbp) {
            if (!fetchedByPlatform.has(p) && Array.isArray(arr))
              fetchedByPlatform.set(p, arr);
          }
          const all0: { platform: string; title: string }[] = [];
          for (const [platform, topics] of fbp) {
            if (!Array.isArray(topics)) continue;
            for (const t of topics) {
              const title = (t?.title || t?.word || t?.name || "")
                .toString()
                .trim();
              if (title) all0.push({ platform, title });
            }
          }
          if (all0.length > 0) {
            const tags0 = await tagTopicsByDomains(
              all0,
              [subject0],
              userGlossary
            );
            const hits0 = all0.filter((_, idx) =>
              (tags0.get(idx) || []).includes(subject0)
            );
            if (hits0.length <= 3) {
              sparseOverview = true;
              sparseHitCache = { subject: subject0, hits: hits0 };
              // 扳路由：后续预取/提示词/出口全部复用既有 entity 管线，不在热榜链路里另造一套。
              isHotRequest = false;
              clsEntity = true;
              entityFollowup = false;
              chatSubject = subject0;
              subjectQualifier = "";
              turnTypeStamp = "overview";
              // 源头禁令（2026-09 图2实锤）：0命中/稀疏改道轮，模型（尤其在不调工具直接
              // 出正文时）会拿近30天/全网搜到的不相关内容，仿冒确定性领域榜格式
              // （"🔥 微博 今日热点"+"1. 标题【领域】"分节）整段倒在回复里，与系统置顶的
              // "今日0命中"灰条自相矛盾，而且全是硬贴标签的无关条目（蜗牛/金镯被判成女性主义）。
              // 工具拦截只在工具循环内生效，这条提醒保证模型一开口就知道自己只能写速览。
              sparseBanContent = `【本轮路由·最高优先级】「${subject0}」在今日各平台实时热榜中${
                hits0.length === 0
                  ? "【没有】直接相关的热点"
                  : `只有 ${hits0.length} 条直接相关热点`
              }——该对照结果（含${
                hits0.length === 0
                  ? "「今日暂无」灰条"
                  : "命中条目与「结果较少」提示"
              }）已由系统在你回复的【最上方自动生成】，你严禁重复。本轮你【唯一】的任务：直接按【主体速览】四步结构围绕「${subject0}」写话题速览，第一行必须是【主体速览】。【严禁】事项：①严禁输出任何热榜列表形态——包括"🔥 平台 今日热点/今日热榜"分节行、带数字序号和【${subject0}】标签的条目、"已从各平台抓取/筛选出以下热点/其余平台…暂无…近30天…由系统补充"之类说明句；②严禁调用任何热榜抓取/筛选工具，事实不足只能调 search_web_fact；③【严禁】把全网/近30天搜到的不相关内容硬贴上「${subject0}」标签凑成榜单——查不到直接相关的料，就在速览里如实说明并给切入方向，不许拿无关内容填充。`;
            }
          }
        } catch (e) {
          console.warn(
            `[chat] 单领域「${subject0}」稀疏改道前置判定失败，保持原热榜链路:`,
            (e as Error)?.message || e
          );
        }
      }
    }
    // 主体聚焦（entity）：本轮非抓热点且分类器判消息指向具体主体（且不是追问轮/任务轮）时，
    // 服务端先确定性检索该主体资料（不依赖模型自觉调工具），注入提醒供"主体速览"使用——根治
    // "人物身份张冠李戴/凭记忆硬答"。检索失败或无结果就保持空串，模型按"无资料"处理：宁缺勿错，
    // 禁止编造。追问轮跳过预取：上文已有完整语境，模型需要事实时自己调 search_web_fact 核实即可。
    // 本轮全网搜索参考来源（2026-09 统一收口）：预取四路/工具核实/兜底补挂命中的链接
    // 都收进这里，任一成功出口通过 refsPayload() 随响应返回 refs:{sites,videos}；
    // 纯热榜轮（没有任何全网搜索）自然为空、不带 refs。
    // 注意：必须在主体预取（needFactPrefetch）之前初始化——预取四路一完成就要推入。
    const turnRefs: ChatRef[] = [];
    const turnRefSeen = new Set<string>();
    const pushTurnRefs = (
      items: { title?: string; url?: string; source?: string; published?: string }[]
    ) => {
      const refPlan = queryPlan(lastUserContent);
      for (const it of items || []) {
        const u = (it?.url || "").trim();
        if (!u || turnRefSeen.has(u)) continue;
        const refTitle = (it.title || "").trim();
        // 百科类参考源的统一相关性门控：LLM 工具路（search_web_fact）绕过合并层分桶
        // 直接推 refs，单字/词义页（"董"/"降"/"广州市"）会从这里漏出，故在最终收口
        // 再卡一道（与 place() 同口径，幂等）；词典/翻译站对热点问题一律不收。
        let refHost = "";
        try {
          refHost = new URL(u).hostname;
        } catch {}
        if (
          DICT_SITE_HOST_RE.test(refHost) &&
          !titleRelevant(refTitle, refPlan.main, refPlan.context)
        )
          continue;
        if (
          ENCYCLOPEDIA_HOST_RE.test(refHost) &&
          !titleRelevant(refTitle, refPlan.main, refPlan.context)
        )
          continue;
        turnRefSeen.add(u);
        turnRefs.push({
          t: refTitle,
          u,
          s: (it.source || "").trim() || undefined,
          d: (it.published || "").trim().slice(0, 10) || undefined,
        });
      }
    };
    let entityFactBlock = "";
    // 主体 × 今日热榜对照块（2026-09）：点名具体主体时，先拿今日热榜做语义匹配，
    // 命中条目/0命中说明由服务端确定性置顶（见 buildEntityHotBlock），不依赖模型自觉。
    let entityHotBlock = "";
    let entityHotUrlMap: Record<string, string> = {};
    // 预取触发（P0 扩大）：entity 首次点名轮 + chat 咨询轮【含具体主体】都预取。
    // chat 咨询（"村超值得做吗""Cursor值得买吗"）此前不预取，全靠模型自觉调工具——
    // 模型偷懒就凭记忆编造事实，是幻觉防堵体系最后一个风险窗口。检索词：entity 轮用整句
    // （可能是裸词点名或问句）；chat 轮用分类器提取的主体名（更短更准，避免问句里的
    // "值得吗/怎么办"等噪声稀释检索）。寒暄（subject 为空）不预取，零浪费。
    // 用户问句的统一拆解（概念提问护栏）："cs中的研发芯片是什么梗"剥成"cs 研发芯片"。
    const userPlan = queryPlan(lastUserContent);
    const needFactPrefetch =
      !isHotRequest && !entityFollowup && !isTaskRequest && (clsEntity || chatSubject);
    if (needFactPrefetch) {
      // "电竞的"澄清轮：lastUserContent 是残句"电竞的"，直接拿去检索会跑偏；
      // 用上轮主体 + 限定词拼成"487 电竞"检索，命中用户选定的那个含义。
      // 概念提问（什么梗/什么意思/什么是…）不用分类器抽的 chatSubject：它会把
      // "研发芯片"的中心语"芯片"当主体，整条预取跑到半导体行业去——用剥壳短语。
      const q = (
        sparseOverview
          ? chatSubject
          : clsEntity
            ? subjectQualifier && chatSubject
              ? `${chatSubject} ${subjectQualifier}`
              : lastUserContent
            : userPlan.isConceptAsk
              ? userPlan.main
              : chatSubject
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      // 热榜对照用更干净的主体名（分类器提取的 chatSubject 优先，退回到剥壳短语/整句），
      // 与事实检索并行启动，不额外串行等待。
      const hotSubject = (
        userPlan.isConceptAsk ? userPlan.main : chatSubject || lastUserContent
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      const entityHotPromise: Promise<{
        block: string;
        urls: Record<string, string>;
      }> = hotSubject
        ? (async () => {
            try {
              // 稀疏改道已抓过全榜并算过命中：直接复用，零重复抓取/重复判定。
              if (sparseHitCache && sparseHitCache.subject === hotSubject) {
                return {
                  block: buildEntityHotBlock(hotSubject, sparseHitCache.hits),
                  urls: buildTopicUrlMap(fetchedByPlatform),
                };
              }
              const fbp =
                fetchedByPlatform.size > 0
                  ? fetchedByPlatform
                  : await fetchPlatformsHot(platforms);
              const all: { platform: string; title: string }[] = [];
              for (const [platform, arr] of fbp) {
                if (!Array.isArray(arr)) continue;
                for (const t of arr) {
                  const title = (t?.title || t?.word || t?.name || "")
                    .toString()
                    .trim();
                  if (title) all.push({ platform, title });
                }
              }
              if (!all.length) return { block: "", urls: {} };
              const tags = await tagTopicsByDomains(all, [hotSubject], {});
              const hits = all
                .map((it, idx) => ({ it, tg: tags.get(idx) }))
                .filter(({ tg }) => (tg || []).includes(hotSubject))
                .map(({ it }) => it);
              return {
                block: buildEntityHotBlock(hotSubject, hits),
                urls: buildTopicUrlMap(fbp),
              };
            } catch (e) {
              console.warn(`[chat] 主体「${hotSubject}」今日热榜对照预取失败，降级为空:`, (e as Error)?.message || e);
              return { block: "", urls: {} };
            }
          })()
        : Promise.resolve({ block: "", urls: {} });
      if (q) {
        try {
          // 三路并集：短词不限时资料（身份/归属/属性）+ 近30天动态 + 视频类目动态，一次拿全。
          // 另并行补两路（2026-09 实测补丁）：
          // ① 历史名梗/争议事件——主路新帖置顶+截断10条会把"我才是老大事件""无职转生
          //   封杀"这类这个人最出圈的老梗挤出资料，导致切入区只有近期没有名场面；
          // ② 黑话/外号词源——"宗出=畜谐音""宗区=粉丝区"这类社区造词只搜原词召回不到
          //   解释帖，模型就开始瞎编词源（如编"ID像zombie"）。两路失败静默降级。
          // 短主体名：后缀扩展路必须挂短词——varyQuery 会把查询截成 3 个词，
          // 直接拿整句 q（如"csgo if梗的来源"）拼后缀时后缀被整句挤掉、扩展路静默退化成主路。
          // 优先用分类器提取的主体名；没有就取 q 前两段兜底。
          const shortQ = (
            userPlan.isConceptAsk
              ? userPlan.main
              : (chatSubject || "").trim() ||
                queryPlan(q).main
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 20);
          // 四路并行（总耗时≈单路）：
          //  prof  主体整句——身份/属性/综合资料
          //  event 走红起因——领域无关的通用词面（"怎么火/起因/经过"对梗/事件/人物/产品都成立），
          //        专门召回"最近因哪件具体的事进入公众视野"的来龙去脉帖，治"只讲百科不讲最新事件"
          //  meme  历史名场面/争议——人物最出圈的老梗
          //  slang 含义/外号/由来——黑话词源解释帖
          // 用户原句自带的分类名词（梗/意思/由来/出处/定义…）拼回裸短语直搜一路——
          // 疑问壳剥掉后这个方向词也丢了，它决定引擎召回哪类页面。纯机械拼接，
          // 不掺入任何我们猜测的领域或别名；与已有 q 重复就不发。
          const catQ =
            userPlan.extra[0] &&
            userPlan.extra[0].replace(/\s+/g, "") !== q.replace(/\s+/g, "")
              ? userPlan.extra[0]
              : "";
          const [prof, event, meme, slang, catWord, flashRaw] = await Promise.all([
            searxUnionSearch(q, 10, true),
            shortQ
              ? searxUnionSearch(`${shortQ} 怎么火 起因 经过`, 6, true).catch(
                  () => [] as UnionHit[]
                )
              : Promise.resolve([] as UnionHit[]),
            searxUnionSearch(`${shortQ} 名场面 争议 黑历史`, 6, true).catch(
              () => [] as UnionHit[]
            ),
            searxUnionSearch(`${shortQ} 什么意思 外号 由来`, 6, true).catch(
              () => [] as UnionHit[]
            ),
            catQ
              ? searxUnionSearch(catQ, 6, true).catch(() => [] as UnionHit[])
              : Promise.resolve([] as UnionHit[]),
            // 第六路：财联社/华尔街见闻/财新/格隆汇/澎湃财经快讯（5min 缓存、全 allSettled，
            // 不增延迟、绝不拖垮主链路）。通用引擎对财经政策词索引慢，这是降准类问题的一手源补位。
            flashNewsSearch(40)
              .then((hs) =>
                hs.map(
                  (h): UnionHit => ({
                    title: h.title,
                    url: h.url,
                    source: hostLabel(h.url),
                    ...(h.published ? { published: h.published } : {}),
                    content: h.content,
                  })
                )
              )
              .catch(() => [] as UnionHit[]),
          ]);
          // 快讯相关性过滤：英文/数字 token 要求整体出现；中文 ≤2 字要求完整包含，
          // 更长词用 2-gram 命中。非财经问题自然 0 命中，不注入、不浪费席位。
          const flashHitRelevant = (text: string, core: string): boolean => {
            const t = text.toLowerCase();
            for (const tok of core.toLowerCase().split(/\s+/).filter(Boolean)) {
              if (/[a-z0-9]/.test(tok)) {
                if (t.includes(tok)) return true;
              } else if (tok.length <= 2) {
                if (t.includes(tok)) return true;
              } else {
                for (let i = 0; i + 2 <= tok.length; i++)
                  if (t.includes(tok.slice(i, i + 2))) return true;
              }
            }
            return false;
          };
          const flash = shortQ
            ? flashRaw
                .filter((h) =>
                  flashHitRelevant(`${h.title} ${h.content || ""}`, shortQ)
                )
                .slice(0, 4)
            : [];
          const seenUrl = new Set<string>();
          const factLines: string[] = [];
          // 同步收集入选的原始 hit（带 url/source/published），供本轮参考来源块使用
          const refHits: UnionHit[] = [];
          const fmtHit = (it: UnionHit): string => {
            const date = it.published ? `[${it.published}] ` : "";
            const snip = String(it.content || "")
              .replace(/\s+/g, " ")
              .slice(0, 160);
            return `- ${date}${it.title}${snip ? `：${snip}` : ""}（${it.source}）`;
          };
          // 主区席位顺序（内容中立规则：召回路由的意图纯度决定优先级）：
          // ① 用户原句自带分类名词（梗/意思/由来/定义…）时，用该词直搜那一路排最前——
          //    问句里的分类词是用户亲手写明的意图，这一路召回的页面对"问的是哪类东西"
          //    最对口（≤5 条，不独占）；② prof 身份/综合资料到 7 条；③ event 走红起因补到 10。
          // URL 去重，总量仍是 10 条。
          if (catQ) {
            for (const it of catWord) {
              if (!it?.url || seenUrl.has(it.url)) continue;
              seenUrl.add(it.url);
              factLines.push(fmtHit(it));
              refHits.push(it);
              if (factLines.length >= 5) break;
            }
          }
          for (const it of prof) {
            if (!it?.url || seenUrl.has(it.url)) continue;
            seenUrl.add(it.url);
            factLines.push(fmtHit(it));
            refHits.push(it);
            if (factLines.length >= 7) break;
          }
          for (const it of event) {
            if (!it?.url || seenUrl.has(it.url)) continue;
            seenUrl.add(it.url);
            factLines.push(fmtHit(it));
            refHits.push(it);
            if (factLines.length >= 10) break;
          }
          // 财经快讯独立区（财联社/华尔街见闻/财新/格隆汇/澎湃，命中主体词才入选）：
          // 一手信源，权威性高于社区帖；URL 与主区去重，单独成段提示模型优先采信。
          const flashLines: string[] = [];
          for (const it of flash) {
            if (!it?.url || seenUrl.has(it.url)) continue;
            seenUrl.add(it.url);
            flashLines.push(fmtHit(it));
            refHits.push(it);
          }
          // 补充资料：老梗/词源两路合并去重，独立成区（让模型知道这部分"不限时效、优先用于名场面切入"）
          const suppLines: string[] = [];
          for (const it of [...catWord, ...meme, ...slang]) {
            if (!it?.url || seenUrl.has(it.url)) continue;
            seenUrl.add(it.url);
            suppLines.push(fmtHit(it));
            refHits.push(it);
            if (suppLines.length >= 8) break;
          }
          // 预取四路入选链接 → 本轮参考来源（网站/视频由出口统一分组）
          pushTurnRefs(refHits);
          if (factLines.length || flashLines.length)
            entityFactBlock = `\n【已核实检索资料（服务端刚刚实时检索所得，写【主体速览】故事区必须以此为准；与你的记忆冲突时一律以资料为准；资料没有的属性宁可不写，严禁编造精确数字或归属。其中带日期的近期条目用于讲清"它最近为什么火/最新进展"，行首[日期]越新越优先采信，旧条目只作背景铺垫）】\n${factLines.join(
              "\n"
            )}\n${
              flashLines.length
                ? `\n【权威财经快讯·一手信源（财联社/华尔街见闻/财新/格隆汇/澎湃刚刚发布的电报快讯；涉及金融政策、宏观数据、市场动向的事实与数字，这部分优先级最高，社区帖说法与此冲突时以此为准）】\n${flashLines.join(
                    "\n"
                  )}\n`
                : ""
            }\n${
              suppLines.length
                ? `\n【补充资料·历史名梗/外号词源（不限时效的检索结果；写"名场面/老争议/外号由来"类切入时优先用这部分，不受"只写近期"限制；仍然没有的就先调 search_web_fact 核实，查不到宁可不写。⚠️ 这部分由多路检索拼合，可能混入与该主体无关的同名/串味帖子（别的游戏、别的圈子、同名梗）——与主体对不上的结果一律丢弃，【严禁】把无关帖子的内容写成切入条目）】\n${suppLines.join(
                    "\n"
                  )}\n`
                : ""
            }`;
        } catch (e) {
          console.warn(`[chat] 主体速览事实预取失败（q=${(q || "").slice(0, 40)}），不带资料继续:`, (e as Error)?.message || e);
        }
      }
      // 收集今日热榜对照结果（与事实检索并行，到这里才 await，不额外阻塞）
      try {
        const eh = await entityHotPromise;
        entityHotBlock = eh.block;
        entityHotUrlMap = eh.urls;
      } catch (e) {
        console.warn("[chat] 主体今日热榜对照结果回收失败:", (e as Error)?.message || e);
      }
    }
    // （原"关键词通道数组提取器"已并入上方统一意图分类：正则没命中领域时一律走同一个
    // 分类 prompt——它对"清单内同义映射与清单外逐字提取"都比数组提取器可靠，A4 回归的教训。）
    // 本轮实际生效的领域清单：消息点名 > 右上角选择；普通聊天轮恒为空
    const turnDomainList: string[] = isHotRequest
      ? msgDomains.length
        ? msgDomains
        : currentDomainList
      : [];

    // （无 Key 已在请求入口统一拦截并返回 no_key 引导，这里不再重复检查。）
    const systemMsg = {
      role: "system",
      content: buildSystemPrompt(domain, platforms, userGlossary),
    };

    let conversationMessages = [systemMsg, ...messages];
    // 领域可能刚被改名/增删，但对话历史里还留着旧领域的锁定声明、筛选结果和标签。
    // 在最后一条用户消息前插入一条“当前领域”提醒（最高时效性），强制本次结果只依据最新领域集合，
    // 避免模型沿用历史里的旧标签——即"改完标签，新跑的结果必须符合新标签"。
    const insertReminder = (content: string) => {
      const reminder = { role: "system", content };
      const lastUserIdx = conversationMessages
        .map((m: any) => m.role)
        .lastIndexOf("user");
      if (lastUserIdx >= 0) conversationMessages.splice(lastUserIdx, 0, reminder);
      else conversationMessages.push(reminder);
    };
    // 稀疏改道的源头禁令最早插入（先于下方四步结构 reminder），双重保证模型不私发热榜。
    if (sparseOverview && sparseBanContent) insertReminder(sparseBanContent);
    if (isTaskRequest) {
      // 任务轮（泛化：写口播稿/脚本/文案/润色/改写/翻译等任何产出请求）：轻量提醒直接完成任务。
      // 不注入主体速览大结构——用户要的是产出本身，两区切入+推销句全是浪费 token 的结构绑架。
      insertReminder(
        `【重要·本轮回复方式，覆盖对话历史里任何结构惯性——即使之前几轮你都在输出"主体速览/切入"结构，本轮也必须改】用户在要求内容产出任务（写稿/脚本/文案/润色/改写/翻译等）：直接完成任务本身，按消息与上文自行补全题材、主体、角度与篇幅。涉及具体事实细节（数字/日期/归属/转会/奖项）先调 search_web_fact 核实，查不到的宁可不写、【严禁】编造；涉及真实人物的当前年龄，必须先核实出生日期、按今天折算后才能写具体年龄数字，查不到出生日期就一律不写具体年龄（程序会用检索到的出生日期复核稿件里的年龄，不一致会被强制改写）。【严禁】输出【主体速览】/"直接相关的切入"/"相关领域的切入"等分区结构，【严禁】结尾加"这些方向同样可以让我深挖资料或直接写稿"这类推销句。`
      );
      // 本地知识库 RAG：用最后一条用户消息检索真实爆款口播范文，仅注入写稿类任务轮。
      // 检索服务不可用时静默跳过，绝不拖垮主链路。
      try {
        const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
        const lastUserText = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
        if (lastUserText.length >= 4) {
          const domainWords = [
            ...String(domain || "").split(/[、，,\/\s]+/),
            ...msgDomains,
            ...currentDomainList,
          ].map((s) => String(s).trim());
          const kbCategory = KB_CATEGORIES.find((c) => domainWords.includes(c));
          const hits = await retrieveKnowledge(lastUserText, { topK: 4, category: kbCategory });
          const kb = formatKnowledge(hits);
          if (kb) insertReminder(kb);
        }
      } catch (e) {
        console.warn("[chat] 本地知识库 RAG 检索失败，本轮跳过范文注入:", (e as Error)?.message || e);
      }
    } else if (entityFollowup) {
      // 追问轮：上文已给过该主体的完整速览，用户只是追问/补充某个具体信息点。
      // 直接克制地答这一个追问；重新串一遍速览大面板既耗 token 又打断对话。
      insertReminder(
        `【重要·本轮回复方式，覆盖对话历史里任何结构惯性】用户在【追问/补充】上文已经展开过的主体——不是首次点名，不要重新展开全貌：直接、克制地回答这一个追问（问什么答什么，一般不超过 6-8 句），读者默认是不懂这个圈子的普通人：圈内黑话/专有词第一次出现就地括号大白话注释（大众通用词不注释）；问"怎么火的/来龙去脉/经过"时按时间顺序把事情讲成一条线；资料不足或说法冲突的点合并成【一句话】在结尾说，正文里严禁反复声明"查不到/无法确认"。【严禁】输出【主体速览】/"直接相关的切入"/"相关领域的切入"结构，【严禁】结尾加"这些方向同样可以让我深挖资料或直接写稿"这类推销句。涉及具体事实细节（数字/日期/归属/转会/奖项）先调 search_web_fact 核实：资料与上文冲突时以资料为准并点一句，查不到就明说，【严禁】凭记忆编造。`
      );
    } else if (!isHotRequest) {
      // 普通对话/其他任务轮：彻底解绑领域逻辑，正常回答，不抓热榜不筛领域
      const reminder = {
        role: "system",
        content: `【重要·本轮回复方式，覆盖对话历史里任何反问/澄清式回复的习惯——即使之前几轮你都反问了，本轮也必须改】当前界面领域锁状态（以此为准，不要自行猜测）：${domain ? `已锁定「${domain}」` : "未锁定任何领域"}。用户这条消息不是抓热榜请求：【不要】调用热点抓取工具、【不要】罗列热榜、【不要】把领域强加进无关回答（search_web_fact 事实核查工具不受此限：回答涉及具体人物/战队/组织等事实细节前【必须】先调它核实）。【先判断是否任务模式】若用户在要求具体产出任务（写开场白/写稿/润色/翻译/改错等任何"帮我做X"类请求），【无论消息里有没有主题词】：直接完成任务本身，【严禁】输出任何分区结构、也【严禁】加"这些方向同样可以让我深挖资料或直接写稿"这类结尾句。否则（用户抛出一个具体主体——人物/战队/组织/公司/作品/产品/APP/节目/店铺/地点/事件/题材均可，如"shiro""村超""Cursor""中年危机"），本轮回复必须严格按下面四步结构输出，两个小节标题必须逐字使用、不得改写，条数必须给足：\n【输出起头】第一行必须直接是【主体速览】。⚠️ 今日热榜对照（该主体在不在今日各平台热榜、命中的热榜条目、以及"今日暂无相关热点/相关结果较少"的提示行与分隔线）已经由【系统在你回复的上方自动生成】：你【严禁】自己输出任何【热榜速报】行、热榜条目列表、"今日热榜暂无/较少"之类说明或分隔线，也【不要】复述上方已有的热榜对照内容——直接从【主体速览】开始写即可。正文前【严禁】输出任何思考过程、检索情况说明或过渡语（如 "Let me check..."、"Based on the materials..."、"根据检索到的资料…" 之类）——那些内容用户不可见，直接给正文。\n【条目禁 emoji】下面两区所有"- "条目行内严禁添加任何 emoji/图标装饰（如🔥💰⚡⭐），条目行=纯文字（可带行尾【领域】胶囊），不加图标不加修饰符号。\n第一步【主体速览·故事区】（读者是完全不懂这个圈子/领域的普通人，目标是一眼看懂来龙去脉，不是堆资料。硬性篇幅：除第一行外最多 2 个自然段、故事区全文不超过 260 字——输出前必须逐字数字数，超了就整句删到 260 以内，优先删：活动/发布会名称、参数与价格罗列、与本次事件无直接因果的背景句，只留"什么时间、谁、出了什么事、现在怎样"。信息密度优先，严禁百科长文）：
第一行必须以【主体速览】开头，紧跟一句 30 字内大白话。按用户问的东西分三种开口法：
① 问的是正在发生的【事件/动态】（抢不到、售罄、官宣、夺冠、翻车、冲突、政策落地这类"发生了一件事"）：第一句直接概括【发生了什么】，随后按时间讲清"什么时间、谁、出了什么事、现在怎样"。事件涉及的公司、产品、名人若大众本来就熟，【严禁】再做百科铺垫（创立背景、产品线、个人履历一律不写）；只有当事人对普通人确实陌生（不知名的人、小众机构）时，才允许在叙事里用【半句】交代身份（是谁、干嘛的）并立刻回到事件。此规则对一切话题通用，不许有例外。
② 问的是概念、说法、产品本身：第一句讲清"是什么"；问人物：第一句讲清"是谁"（一句身份即可，生平放后面脉络里）。
③ 问判断/建议（"值得做吗、怎么看、还能不能入局、值得买吗、现在做晚不晚"）：第一句必须先给【明确态度】（值得/不建议/有机会但……），紧跟 1-2 句事实依据（热度阶段、竞争是否饱和、近期新变化），【严禁】只罗列事实、把判断藏到段落最后。
第一行之后最多 3 个自然段，从下面三类里自选、用时间或逻辑连接词自然串成故事，不适用的整段删除——【禁止】为凑结构编造，不加小标题、表格或参数清单：
① 由头：最近为什么进入公众视野——时间、场合、相关方、经过、后来有没有反转，按时间讲成一条线；用户问"是什么梗/来源/怎么火的/怎么回事"时这是【全篇重点】，优先用资料里带日期的新条目讲透；没有近期由头（历史人物、静态概念）整段跳过，严禁硬编"最近引发热议"；
② 脉络：梗/说法→起源与扩散；人物→只写与本问相关的关键经历；事件→起因经过与最新进展；概念→原理并配一个生活类比。【严禁】编年体长履历、产品线/参数大全式铺陈；
③ 现状：常见用法、外界评价、争议、影响或常见误解，挑适用的写。
【圈内词就地翻译】话题所属小圈子的专有词、缩写、昵称、行话，第一次出现就地括号给大白话。判断标准：把词单独拿给不关注该领域的普通人，字面能懂就【不注释】，看不懂或会误解才注释；大众通用词（粉丝、比赛、夺冠、网友、发布等）、用户自己问题里已用过的词、学校常识词一律不注释，严禁每行都注释。真正需要注释的行话达到 4 个以上，才在故事区末尾另起一段、每行一个用"- 词：大白话解释"集中列出（不许用【】胶囊）；少于 4 个只在正文括号里注释，不列清单。
【不确定只说一次】资料不足或说法冲突的点，全文【最多】在故事区结尾用一句话集中说明，正文叙事中【严禁】反复插"无法确认/没检索到出处/你自己再核"，更不许因此不敢讲已确认的事实。
事实细节必须以下方"已核实检索资料"为准（没有资料块时先调 search_web_fact 核实再写）；资料没有的属性【宁可不写，严禁编造精确数字或归属】。\n第二步：输出一行标题「直接相关的切入」，下面给 4-6 个【全部围绕该主体本身】的切入方向，两类条目直接混排在同一个小节里：【严禁】再单独输出"特质衍生的切入"这类小标题。①直接切入——它最近具体赢了什么/做了什么/发了什么、生涯或迭代轨迹如何、下一步看点在哪；②特质衍生切入——先提炼该主体最有辨识度的特质/人设/标签/梗/争议点，再由特质自然衍生出观众一看就懂的内容方向。特质衍生条目也【必须落到该主体本身的具体事实】上（写明主体的名字/具体经历/具体表现），最多适度引申，【严禁】抛开主体空谈特质概念；每条独占一行、不打【】胶囊（就着这个具体主体说事，这是优先级最高的一区；【严禁】写成"跳出该主题/换赛道/跳出领域"之类让用户离开原话题的内容——用户点名这个主体，就要先答这个主体本身）。\n【切入条目写法·三条硬规，第二步与第三步的每条都必须遵守】\n（1）先给"切口"再带半句料：每条的主体是一个拿起来就能开拍的【选题切口】——一句明确的判断、反常识、冲突、站队、人群情绪或实用信息差，让读者一眼知道这期"要讲个什么理"；搜到的具体资料只能作半句短佐证（谁的什么事/哪句话，点到为止），【严禁】写成"X月X日某平台发了什么，可做…"的资料流水账——日期和平台名只有在"时效本身就是看点"时才允许出现，且不得放在句首，也不许一条里堆两件以上的料；\n（2）每条行尾必须带机器检索契约〔搜：词1 词2 词3〕：2-4个网友/圈内人真实会输入搜索框的词，每个2-8字、词间空格，一律从【本条已核实资料】里选——人物/作品/事件名优先；圈内黑话、外号、蔑称、梗句原词必须用网友原词原样写（哪怕只有2-3个字，不要翻译成书面语），再配1个大白话关联词；【严禁】放"向/可做/一期/争议/为什么/怎么样/盘点"这类编辑元话语或整句，【严禁】造资料里不存在的词；〔搜：…〕标记是给程序看的、只允许出现在条目最末尾，正文其它位置不许出现；\n（3）格式骨架（XX 为占位，不是让你写"XX"）：- XX向：一句切口判断，半句事实佐证〔搜：圈内原词 大白话词 作品名〕。\n第三步：输出一行标题「相关领域的切入」，先判断这个主体本身所属或强相关的领域（自行判断，【不受右上角所选领域限制】，如 shiro→电竞、Cursor→AI编程工具、村超→体育/乡村旅游），再把该主体的处境泛化到大众普遍领域（如电竞选手→职场成长的"青春饭"怎么办、财经理财的转会费与身价、情感两性的聚少离多；产品→消费决策；地点→旅行方式），给 3-5 个切入方向，每条独占一行；每条同样遵守上面的三条写法硬规，行尾先带〔搜：词1 词2〕检索契约（2-3个词即可），再用独立的【相关领域名】胶囊收尾（如【电竞】【职场成长】）；右上角锁定的领域恰好与主题真相关时优先列出；不要硬凑不相关的领域。\n第四步：结尾一句"这些方向同样可以让我深挖资料或直接写稿"。\n【严禁】只回"说'抓热点'我帮你抓"、严禁反问"你想做哪一块/哪个项目"来拖延、严禁只罗列"我可以帮你A/B/C"菜单而不给实质方向。若用户明确在要求别的任务（如写稿/润色/翻译/改错），正常完成该任务即可，【完全不套此结构】：既不要输出两个区的标题，也【不要】加"这些方向同样可以让我深挖资料或直接写稿"这类结尾句。只有"你好""谢谢"这类完全没有具体主题的寒暄才不需要此结构。\n【人物类主体·历史名梗硬性要求】主体是人物（选手/UP主/主播/网红/名人）时，"直接相关的切入"在近期动态条目之后，必须再给 1-2 条这个人【最出圈的历史名梗/争议事件/名场面】（哪怕发生在数月或数年前，如出圈名场面、封号/封杀事件、知名纠纷）——近期内容权重最高、排最前，但只写近期会让新人完全错过这个人最核心的争议标签。这类老梗优先用下方"补充资料"里的素材；补充资料里没有就先调 search_web_fact 搜「主体名 名场面/争议事件/黑历史」核实，查不到就放弃，【严禁】凭记忆编造名场面。\n【跨轮纠错·防止上文污染】对话历史里你此前对同一个词做过的猜测性理解（例如把某个圈子的黑话词误当成别的圈子概念去解释），如果本轮用户加了更明确的限定词（如"csgo 宗出"），说明上一轮认错了对象：必须【完全丢弃】上一轮的解释，按本轮限定重新检索、从零理解该主体；上一轮里与新主体无关的概念、例子、结论一个字都不许带进本轮回复。\n【黑话/谐音梗纪律】社区黑话/外号/谐音骂法（如"宗出/宗处"谐音"畜"、"宗区"既指选手粉丝聚集地也与"蛆"谐音双关）：含义必须以下方资料为准；资料能看出用法（都在用它骂某人打得菜）但没给权威词源解释时，可以写明这是"谐音贬义黑话"（并标注是谐音推断），【严禁】编造词源考据（"ID 像 zombie""名字来源于某外文词"这类资料没写的词源故事一个字都不许写）；ID/名字的含义资料没明说就不写。\n【切入条目事实纪律】"直接相关的切入"每条里出现的具体事实——某句话的说话人（家属/粉丝/选手本人）、某人的感情或婚姻状态、某梗的确切说法、ID 的含义——必须能在下方资料里指认来源；资料没有的【严禁】写进条目，不许用"趣味向/考据"的名义虚构语录、家属言论或感情状态；拿不准的梗只写方向不编细节；两个不同的梗只有在资料明确关联时才能放进同一条，【严禁】把不相干的梗自行拼接因果（例如把一个颜值相关梗和一句没出处的状态梗硬缝成一条）。${entityFactBlock}`,
      };
      const lastUserIdx = conversationMessages
        .map((m: any) => m.role)
        .lastIndexOf("user");
      if (lastUserIdx >= 0) conversationMessages.splice(lastUserIdx, 0, reminder);
      else conversationMessages.push(reminder);
    } else if (msgDomains.length) {
      // 消息里显式点名领域 → 本轮以消息为准，优先级高于右上角选择
      const selNote = currentDomainList.length
        ? `右上角当前选的是：${currentDomainList
            .map((d: string) => `「${d}」`)
            .join("、")}，本轮以消息里点名的为准`
        : `右上角当前未选具体领域`;
      const reminder = {
        role: "system",
        content: `【重要·以此为准】用户在本条消息里明确点名了领域：${msgDomains
          .map((d: string) => `「${d}」`)
          .join("、")}（${selNote}）。本轮的抓取、筛选与打标签只依据消息里点名的这些领域。`,
      };
      const lastUserIdx = conversationMessages
        .map((m: any) => m.role)
        .lastIndexOf("user");
      if (lastUserIdx >= 0) conversationMessages.splice(lastUserIdx, 0, reminder);
      else conversationMessages.push(reminder);
    } else if (domain) {
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
    // 资料收集器（2026-09）：本轮工具实际取回的检索资料（search_web_fact /
    // generate_video_script 的 factBlock），成稿出口的年龄守卫靠它拿出生日期真相
    const factSink: string[] = [];
    // 近30天兜底：小众领域今日无热点时，search_recent_topics_by_domain 的结果收集到这里，
    // 最终由 appendRecentFallback 直接拼进回复正文（不再用气泡框）。
    let recentFallback: {
      domain: string;
      items: { title: string; url: string; source: string }[];
    } | null = null;
    // 出口统一调用：先把近30天兜底条目并入（已按领域过滤），再网站/视频分组；
    // 网站上限 12、视频上限 6（第一层回复默认折叠，不挤正文）。
    const refsPayload = () => {
      if (recentFallback?.items?.length) pushTurnRefs(recentFallback.items);
      if (!turnRefs.length) return {};
      return {
        refs: {
          sites: turnRefs.filter((r) => !VIDEO_REF_RE.test(r.u)).slice(0, 12),
          videos: turnRefs.filter((r) => VIDEO_REF_RE.test(r.u)).slice(0, 6),
        },
      };
    };
    // fetchedByPlatform 已在主体预取之前声明并可能已被"稀疏→话题速览"前置判定填充，
    // 工具循环与确定性出口直接复用，不重新声明。
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
        // 普通对话/其他任务轮：直接返回模型回答，不做任何热榜替换或领域过滤
        //（根治"选了领域后连'王俊凯生日'这类闲聊都被领域热榜顶掉"）
        if (!isHotRequest) {
          // 成稿后处理（2026-09 年龄口径根治·泛化）：聊天内任务轮直接产出的脚本/文案
          // 此前不经过任何守卫——模型记忆里的过时年龄（"18岁的人"）原样进稿，还可能与
          // 另一句"19岁小孩"同稿打架。三步确定性清理：
          // ① AI 腔黑名单清除（与 /api/script 出口同一套）；
          // ② 年龄守卫，资料=本轮工具实际取回的检索资料 factSink + 主体预取 entityFactBlock；
          // ③ 正文出现"X岁"但资料里没有出生信息时，补一路「正文高频拉丁主体名 + 出生」
          //    探测（人物稿最常见形态，如 zont1x/donk）——探到出生信息才让守卫生效，
          //    探不到保持原样（没有真相就不改写）。
          let finalContent = stripStructureLeak(
            lastUserContent,
            assistantMessage.content || "。"
          );
          finalContent = cleanAiTics(finalContent);
          if (/\d{1,3}岁/.test(finalContent)) {
            let ageSrc = [...factSink, entityFactBlock]
              .filter(Boolean)
              .join("\n");
            if (!/出生|生于|born\s/i.test(ageSrc)) {
              const freq = new Map<string, number>();
              for (const w of finalContent.toLowerCase().match(
                /[a-z][a-z0-9_]{2,15}/g
              ) || [])
                freq.set(w, (freq.get(w) || 0) + 1);
              const top = [...freq.entries()].sort(
                (a, b) => b[1] - a[1]
              )[0]?.[0];
              if (top) {
                try {
                  // 双语双查询（与 script 路由 probeBirthBlock 同口径）：只搜中文"出生"
                  // 搜不到英文资料页（Liquipedia/Wikipedia 的 "born July 20, 2005"），
                  // 两路并行不增延迟
                  const [pbZh, pbEn] = await Promise.all([
                    searxUnionSearch(`${top} 出生`, 8, true).catch(
                      () => [] as UnionHit[]
                    ),
                    searxUnionSearch(`${top} born`, 8, true).catch(
                      () => [] as UnionHit[]
                    ),
                  ]);
                  const probe = [...pbZh, ...pbEn];
                  const lines: string[] = [];
                  for (const h of probe) {
                    const t = `${h?.title || ""} ${h?.content || ""}`
                      .replace(/\s+/g, " ")
                      .trim();
                    if (!t || !/出生|生于|出世|born\s|birthday/i.test(t))
                      continue;
                    lines.push(t.slice(0, 160));
                    if (lines.length >= 4) break;
                  }
                  if (lines.length)
                    ageSrc = `${ageSrc}\n${lines.join("\n")}`.trim();
                } catch (e) {
                  console.warn("[chat] 年龄守卫的出生日期补充检索失败，跳过该补充:", (e as Error)?.message || e);
                }
              }
            }
            finalContent = fixAgeClaims(ageSrc, finalContent).text;
          }
          // 主体×今日热榜对照置顶（2026-09）：有服务端实算块时，剥掉模型按旧提示词自行
          // 输出的【热榜速报】行/分隔线（避免重复），再把确定性对照块放到最前；并把命中
          // 热榜条目的原报道 url 带给前端，供「查看详情」置顶核心来源。
          if (entityHotBlock) {
            let stripped = finalContent
              .split("\n")
              .filter(
                (ln) =>
                  !/^【热榜速报】/.test(ln.trim()) &&
                  !/^[─—\-_＝=]{6,}$/.test(ln.trim())
              )
              .join("\n")
              .replace(/^\s+/, "");
            // 稀疏改道双保险：剥掉模型无视禁令私挂的"平台｜标题【领域】"榜单（工具已拦截，
            // 这里防模型凭对话上下文/记忆继续倒榜）。
            if (sparseOverview)
              stripped = stripModelHotList(stripped, [
                chatSubject,
                ...turnDomainList,
              ]);
            finalContent = `${entityHotBlock}\n\n${stripped}`;
          }
          return NextResponse.json({
            content: finalContent,
            toolLogs,
            turnDomains: [],
            turnType: turnTypeStamp,
            ...refsPayload(),
            ...(Object.keys(entityHotUrlMap).length
              ? { topicUrls: entityHotUrlMap }
              : {}),
            // 评测探针（仅 _evalGround 时返回）：咨询/问答轮在工具循环内直接返回的路径
            // （2026-09 补漏——此前探针只挂在循环外的另一条返回路径，工具轮回答的 evalGround
            // 永远缺失，事实忠实度无法核对）。证据=本轮工具实取资料 factSink + 主体预取块。
            ...(rawEvalGround
              ? {
                  evalGround: [entityFactBlock, ...factSink]
                    .filter(Boolean)
                    .join("\n")
                    .slice(0, 6000),
                }
              : {}),
          });
        }
        // 热点请求但本轮未确定任何领域（消息没点名、右上角也没选）→ 全量热榜
        if (!turnDomainList.length) {
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
            const auxBlock = auxTopics.length
              ? await renderAuxTopicsSection(auxTopics, fbp)
              : "";
            return NextResponse.json({
              content: deterministic + (auxBlock ? `\n\n${auxBlock}` : ""),
              toolLogs,
              turnDomains: [],
              turnType: turnTypeStamp,
              topicUrls: buildTopicUrlMap(fbp),
              ...refsPayload(),
            });
          }
        }
        // 已锁定领域 → 无条件走确定性领域筛选替换模型正文（根治提示词自相矛盾导致的漏筛/滥筛）：
        // 与"未选领域"同理，模型常常不抓新榜、而是沿用对话历史里的【旧领域】答复（如上一轮的
        // 「灰灰男」结果）来污染本轮，导致带旧领域内容的兜底块（无【领域】标签，enforceDomainWhitelist
        // 删不掉）泄漏。因此模型没抓就【服务端补抓】，再逐领域确定性筛选，彻底不信任模型正文。
        let baseContent = assistantMessage.content || "完成。";
        let domainFetched = fetchedByPlatform;
        // 热点请求 + 本轮领域（消息点名优先，其次右上角选择）→ 领域筛选
        if (turnDomainList.length) {
          domainFetched =
            fetchedByPlatform.size > 0
              ? fetchedByPlatform
              : await fetchPlatformsHot(platforms);
          const deterministic = await renderDomainFilteredHot(
            domainFetched,
            turnDomainList,
            userGlossary
          );
          baseContent = deterministic
            ? await supplementSparseToday(deterministic, turnDomainList, userGlossary, pushTurnRefs)
            : `今日各平台实时热榜暂无与所选领域直接相关的热点。`;
        }
        const fin = await finalizeFallback(
          baseContent,
          turnDomainList.join("、"),
          recentFallback,
          userGlossary,
          domainUniverse
        );
        // 收尾兜底现搜的近期文章必须进 refs：否则正文有条目但无链接可达（前端靠 refs 把条目标题变可点链接）
        if (fin.refs.length) pushTurnRefs(fin.refs);
        const auxBlock = auxTopics.length
          ? await renderAuxTopicsSection(auxTopics, domainFetched)
          : "";
        return NextResponse.json({
          content: fin.content + (auxBlock ? `\n\n${auxBlock}` : ""),
          emptyNote: fin.emptyNote,
          toolLogs,
          turnDomains: turnDomainList,
          turnType: turnTypeStamp,
          topicUrls: buildTopicUrlMap(domainFetched),
          ...refsPayload(),
        });
      }

      // Process tool calls
      conversationMessages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          console.warn(`[chat] 模型工具调用 ${fnName} 的参数 JSON 非法，按空参数执行; 原文=${(toolCall.function.arguments || "").slice(0, 200)}; 原因:`, (e as Error)?.message || e);
        }

        toolLogs.push(`调用 ${fnName}(${fnArgs.platform || fnArgs.topic || fnArgs.domain || ""})`);

        // 稀疏改道（单领域今日命中≤3→话题速览）时禁止模型再抓全榜：今日热榜的权威结果已由
        // 系统在回复顶部确定性置顶（buildEntityHotBlock）。2026-09 实测模型拿到全榜工具结果后
        // 会无视结构指令，把整榜私挂【领域】标签倒在速览下方（23条大国基建/赛果/讣告垃圾）。
        // 这里直接短路，返回指令性结果，不执行抓取、不进 fetchedByPlatform。
        const sparseHotBlocked =
          sparseOverview &&
          (fnName === "fetch_hot_topics" || fnName === "filter_hot_by_domain");
        const result = sparseHotBlocked
          ? JSON.stringify({
              blocked: true,
              info:
                "本轮是话题速览：今日热榜的权威筛选结果已由系统生成并置顶（含0命中灰条）。禁止再抓热榜、禁止罗列任何热榜标题、禁止给标题加【领域】标签。请直接按【主体速览】四步结构完成回复，事实核查可改用 search_web_fact。",
            })
          : await executeTool(fnName, fnArgs, domain, userGlossary, factSink, pushTurnRefs);

        // 捕获原始抓取结果，供"未选领域"时确定性渲染全量热榜（不依赖模型正文）。
        if (fnName === "fetch_hot_topics") {
          const platform = (fnArgs.platform || "").toString().trim();
          if (platform) {
            try {
              const arr = JSON.parse(result);
              if (Array.isArray(arr) && arr.length > 0) {
                fetchedByPlatform.set(platform, arr);
              }
            } catch (e) {
              console.warn(`[chat] fetch_hot_topics(${platform}) 结果 JSON 解析失败，确定性热榜渲染将缺该平台:`, (e as Error)?.message || e);
            }
          }
        }

        // 收集近30天兜底结果（可能针对多个小众领域被调用多次，合并去重）
        // 未选领域时【绝不收集】：模型常用对话历史里的旧领域（如已删除的「情感变现实操」）
        // 去调此工具，其结果无领域标签，enforceDomainWhitelist 删不掉，会以垃圾兜底形式泄漏给用户。
        if ((!noDomain || msgDomains.length) && fnName === "search_recent_topics_by_domain") {
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
              turnDomainList.length === 0 ||
              dmTokens.length === 0 ||
              dmTokens.some((t: string) => turnDomainList.includes(t));
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
                dmTokens.length && turnDomainList.length
                  ? dmTokens.filter((t: string) => turnDomainList.includes(t))
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
          } catch (e) {
            console.warn("[chat] search_recent_topics_by_domain 结果 JSON 解析失败，该次近30天兜底不收集:", (e as Error)?.message || e);
          }
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
    if (isHotRequest && !turnDomainList.length) {
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
        const auxBlock = auxTopics.length
          ? await renderAuxTopicsSection(auxTopics, fbp)
          : "";
        return NextResponse.json({
          content: deterministic + (auxBlock ? `\n\n${auxBlock}` : ""),
          toolLogs,
          turnDomains: [],
          turnType: turnTypeStamp,
          topicUrls: buildTopicUrlMap(fbp),
          ...refsPayload(),
        });
      }
    }
    // 已锁定领域 → 同样无条件走确定性领域筛选（模型没抓就服务端补抓），达到迭代上限时也不让模型自行筛选。
    if (isHotRequest && turnDomainList.length) {
      const domainFetched =
        fetchedByPlatform.size > 0
          ? fetchedByPlatform
          : await fetchPlatformsHot(platforms);
      const deterministic = await renderDomainFilteredHot(
        domainFetched,
        turnDomainList,
        userGlossary
      );
      const detContent = deterministic
        ? await supplementSparseToday(deterministic, turnDomainList, userGlossary, pushTurnRefs)
        : `今日各平台实时热榜暂无与所选领域直接相关的热点。`;
      const fin = await finalizeFallback(
        detContent,
        turnDomainList.join("、"),
        recentFallback,
        userGlossary,
        domainUniverse
      );
      if (fin.refs.length) pushTurnRefs(fin.refs);
      const auxBlock = auxTopics.length
        ? await renderAuxTopicsSection(auxTopics, domainFetched)
        : "";
      return NextResponse.json({
        content: fin.content + (auxBlock ? `\n\n${auxBlock}` : ""),
        emptyNote: fin.emptyNote,
        toolLogs,
        turnDomains: turnDomainList,
        turnType: turnTypeStamp,
        topicUrls: buildTopicUrlMap(domainFetched),
        ...refsPayload(),
      });
    }
    conversationMessages.push({
      role: "user",
      content: "请总结以上所有工具调用的结果，给出最终回复。",
    });
    const finalMsg = await callLLM(conversationMessages, false);

    // 普通对话轮：不经过领域兜底/白名单处理
    if (!isHotRequest) {
      // 与无工具调用出口同口径：若服务端实算的主体×今日热榜对照块存在（含稀疏改道），
      // 剥掉模型自写的重复速报行后置顶（模型本轮调过工具时也不会丢顶部结构）。
      let nonHotContent = stripStructureLeak(
        lastUserContent,
        finalMsg || "已完成处理。"
      );
      if (entityHotBlock) {
        let bodyBelowBlock = nonHotContent
          .split("\n")
          .filter(
            (ln) =>
              !/^【热榜速报】/.test(ln.trim()) &&
              !/^[─—\-_＝=]{6,}$/.test(ln.trim())
          )
          .join("\n")
          .replace(/^\s+/, "");
        // 稀疏改道双保险：剥掉模型无视禁令私挂的"平台｜标题【领域】"榜单。
        if (sparseOverview)
          bodyBelowBlock = stripModelHotList(bodyBelowBlock, [
            chatSubject,
            ...turnDomainList,
          ]);
        nonHotContent = `${entityHotBlock}\n\n${bodyBelowBlock}`;
      }
      return NextResponse.json({
        content: nonHotContent,
        toolLogs,
        turnDomains: [],
        turnType: turnTypeStamp,
        ...(Object.keys(entityHotUrlMap).length
          ? { topicUrls: entityHotUrlMap }
          : {}),
        ...refsPayload(),
        // 评测探针（仅 _evalGround 时返回）：回传咨询/问答轮服务端实际注入的主体检索事实块，
        // 供事实忠实度评测核对回复中的事实来源。
        ...(rawEvalGround
          ? { evalGround: entityFactBlock.slice(0, 6000) }
          : {}),
      });
    }
    const fin = await finalizeFallback(
      finalMsg || "已完成处理。",
      turnDomainList.join("、"),
      recentFallback,
      userGlossary,
      domainUniverse
    );
    if (fin.refs.length) pushTurnRefs(fin.refs);
    return NextResponse.json({
      content: fin.content,
      emptyNote: fin.emptyNote,
      toolLogs,
      turnDomains: turnDomainList,
      turnType: turnTypeStamp,
      topicUrls: buildTopicUrlMap(fetchedByPlatform),
      ...refsPayload(),
    });
  } catch (e: any) {
    // 静默吞栈会导致"500 但日志空白"排查黑洞——必须把栈打出来
    console.error("[chat] 500:", e?.stack || e);
    // Key 缺失/无效/欠费/限流：返回结构化引导，前端据此渲染「配置 Key / 去充值」按钮
    const action = llmErrorAction(e);
    if (action) {
      return NextResponse.json(
        { content: action.message, toolLogs: [], llmError: action },
        { status: action.httpStatus }
      );
    }
    return NextResponse.json(
      { content: `服务错误: ${e.message}`, toolLogs: [] },
      { status: 500 }
    );
  }
}