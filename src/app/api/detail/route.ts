import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 7000
): Promise<Response> {
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

type Link = { title: string; url: string; source: string; core?: boolean };
type SearchHit = { title: string; url: string; content: string };

// 从 URL 提取来源标签：常见站点给中文友好名，其余显示去掉 www 的主域名
const SOURCE_NAMES: [RegExp, string][] = [
  [/tieba\.baidu\.com/, "百度贴吧"],
  [/zhidao\.baidu\.com/, "百度知道"],
  [/baijiahao\.baidu\.com|baidu\.com/, "百家号"],
  [/zhihu\.com/, "知乎"],
  [/wenku\.so\.com|so\.com/, "360文库"],
  [/bilibili\.com|b23\.tv/, "哔哩哔哩"],
  [/douyin\.com/, "抖音"],
  [/v\.qq\.com/, "腾讯视频"],
  [/ixigua\.com/, "西瓜视频"],
  [/youtube\.com|youtu\.be/, "YouTube"],
  [/weixin\.qq\.com|mp\.weixin/, "微信公众号"],
  [/toutiao\.com/, "今日头条"],
  [/sina\.com|weibo\.com/, "新浪"],
  [/163\.com/, "网易"],
  [/sohu\.com/, "搜狐"],
  [/qq\.com/, "腾讯网"],
  [/thepaper\.cn/, "澎湃新闻"],
];

function sourceOf(url: string): string {
  for (const [re, name] of SOURCE_NAMES) {
    if (re.test(url)) return name;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 权威来源判定：主流新闻门户 + 官媒 + 通讯社。用于给报道取材时优先采信、交叉核对。
const AUTH_DOMAINS =
  /thepaper\.cn|sina\.com|news\.163\.com|163\.com|qq\.com|sohu\.com|toutiao\.com|baijiahao\.baidu\.com|people\.com\.cn|xinhuanet\.com|news\.cn|cctv\.com|cnr\.cn|chinanews\.com|chinadaily\.com|gmw\.cn|ce\.cn|cyol\.com|jfdaily\.com|bjnews\.com|nbd\.com|yicai\.com|caixin\.com|ifeng\.com|huanqiu\.com|stcn\.com|cls\.cn/i;
function isAuthoritative(url: string): boolean {
  return AUTH_DOMAINS.test(url);
}

// 把「热搜平台名」映射到 sourceOf() 会产出的来源标签，用于判断文章/视频是否同平台。
// 例：热搜来自知乎 → 认可 source 为「知乎」的文章；B站 → 「哔哩哔哩」的视频。
// 返回空数组表示该平台没有可直接抓取的对应站点（如小红书），此时走跨平台兜底。
function platformMatchSources(platform: string): string[] {
  const p = platform.toLowerCase();
  if (/知乎|zhihu/.test(p)) return ["知乎"];
  if (/b站|bili|哔哩/.test(p)) return ["哔哩哔哩"];
  if (/抖音|douyin/.test(p)) return ["抖音"];
  if (/微博|weibo/.test(p)) return ["新浪"];
  if (/头条|toutiao/.test(p)) return ["今日头条", "西瓜视频"];
  if (/百度|baidu/.test(p)) return ["百家号"];
  if (/腾讯|qq|v\.qq/.test(p)) return ["腾讯网", "腾讯视频"];
  if (/网易|163/.test(p)) return ["网易"];
  if (/澎湃|thepaper/.test(p)) return ["澎湃新闻"];
  // 小红书、什么值得买等无公开可抓站点 → 空，交给跨平台兜底
  return [];
}

// 自建 SearXNG 接口（部署在腾讯云 VPS，中国区 IP）。
// SEARXNG_URL 例：https://search.example.com 或 http://1.2.3.4:8080
const SEARXNG_URL = (process.env.SEARXNG_URL || "").replace(/\/+$/, "");
const SEARXNG_TOKEN = process.env.SEARXNG_TOKEN || "";

// 调用 SearXNG 的 JSON 接口，返回结构化的标题/链接/摘要
async function searxSearch(
  query: string,
  category: "general" | "videos",
  limit: number
): Promise<SearchHit[]> {
  if (!SEARXNG_URL) return [];
  const u =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}` +
    `&format=json&language=zh-CN&safesearch=0&categories=${category}`;
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
    9000
  );
  const json: any = await res.json();
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of json?.results || []) {
    const url: string = r?.url || "";
    const title: string = (r?.title || "").trim();
    if (!title || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, content: (r?.content || "").trim() });
    if (out.length >= limit) break;
  }
  return out;
}

const isVideoUrl = (u: string) =>
  /bilibili\.com\/video|b23\.tv|youtube\.com\/watch|youtu\.be|douyin\.com|v\.qq\.com|ixigua\.com/.test(
    u
  );

// 去掉书名号/引号/括号/星号/标点等会干扰搜索分词的符号，得到核心词
const cleanTopic = (t: string) =>
  t
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。.！!？?~—\-*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// 相关性打分：文本（标题+摘要）与话题的 2-gram 重合数（完整命中额外加权）
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
  if (t.includes(kw)) score += 2; // 完整包含话题，强相关
  return score;
}

// 百科/词典/搜索引擎自身页面——这类不是"事件报道"，一律剔除
const isGenericRef = (u: string) =>
  /baike\.baidu\.com|wikipedia\.org|wiki[a-z]*\.|\.wiki|hanyu\.baidu|dict\.|cidian|zhidao\.baidu|zhihu\.com\/topic|so\.com\/link|baidu\.com\/s\?|bing\.com\/search|google\.[a-z.]+\/search/.test(
    u
  );

// 汇总去重 + 剔除百科/搜索页 + 按（标题+摘要）相关性排序，丢弃零重合，取前 limit 条
function rankLoose(lists: SearchHit[][], topic: string, limit: number): Link[] {
  const seen = new Set<string>();
  const merged: { l: Link; s: number; i: number }[] = [];
  let idx = 0;
  for (const list of lists) {
    for (const h of list) {
      if (seen.has(h.url) || isGenericRef(h.url)) continue;
      seen.add(h.url);
      const s = relevanceScore(`${h.title} ${h.content}`, topic);
      merged.push({
        l: { title: h.title, url: h.url, source: sourceOf(h.url) },
        s,
        i: idx++,
      });
    }
  }
  return merged
    .filter((x) => x.s > 0) // 与话题零重合的（跑偏/无关结果）直接丢弃
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.l);
}

export async function POST(req: NextRequest) {
  try {
    const { topic, platform, url } = await req.json();
    if (!topic || typeof topic !== "string") {
      return NextResponse.json({ report: "缺少话题信息。", sites: [], videos: [] });
    }
    // 这条热点自身的原文链接（从热榜一路透传下来）。若合法，则无条件作为「核心来源」：
    // 既置顶到参考网站/视频，也作为报道取材的第一篇，解决"主报道没出现在参考文献里"的问题。
    const originUrl =
      typeof url === "string" && /^https?:\/\//.test(url.trim())
        ? url.trim()
        : "";
    const core = cleanTopic(topic);
    const q = encodeURIComponent(core);

    // 先做 SearXNG 检索，拿到真实资料后再据此生成报道（避免 LLM 凭空臆测）
    const [general, videoRes] = await Promise.all([
      searxSearch(core, "general", 30).catch(() => [] as SearchHit[]),
      searxSearch(core, "videos", 30).catch(() => [] as SearchHit[]),
    ]);

    // 文章：general 结果里排除视频站，排序取前 8 条
    let sites = rankLoose([general.filter((s) => !isVideoUrl(s.url))], core, 8);
    // 视频：videos 分类结果 + general 里命中的视频链接，排序取前 8 条
    let videos: Link[] = rankLoose(
      [videoRes, general.filter((s) => isVideoUrl(s.url))],
      core,
      8
    );

    // 选「核心来源」——既喂给报道当依据，也在参考里打标。
    // 规则：① 优先取与热搜同平台的文章/视频（知乎热搜→知乎、B站→哔哩哔哩…）；
    //       ② 该平台没有直接内容时，退而取相关性最高的其它平台内容；③ 最多 1-3 条。
    const byUrl = new Map(
      [...general, ...videoRes].map((h) => [h.url, h] as const)
    );
    const scoreOf = (l: Link) => {
      const h = byUrl.get(l.url);
      return h ? relevanceScore(`${h.title} ${h.content}`, core) : 0;
    };
    // 候选：文章 + 视频，按与话题的相关性从高到低排（搜索页兜底链接此时还没 push 进来）
    const candidates = [...sites, ...videos].sort(
      (a, b) => scoreOf(b) - scoreOf(a)
    );
    // 把热搜平台名映射到 sourceOf() 产出的来源标签，判断「同平台」
    const platformSources = platformMatchSources(platform || "");
    const samePlatform = candidates.filter((l) =>
      platformSources.includes(l.source)
    );
    // 同平台有内容就优先用同平台（最多 3 条）；否则退回最相关的其它平台内容（最多 2 条）
    const coreLinks =
      samePlatform.length > 0
        ? samePlatform.slice(0, 3)
        : candidates.slice(0, 2);
    const coreUrls = new Set(coreLinks.map((l) => l.url));
    const groundHits = coreLinks
      .map((l) => byUrl.get(l.url))
      .filter((h): h is SearchHit => !!h);

    // 原报道链接：无条件纳入核心来源。置顶为报道取材的第一篇，并保证出现在参考网站/视频里。
    const originIsVideo = originUrl ? isVideoUrl(originUrl) : false;
    if (originUrl) {
      coreUrls.add(originUrl);
      // 作为第一篇取材资料（标题用热点主名称，SearXNG 可能已抓到同链接摘要则复用其正文）
      const existingHit = byUrl.get(originUrl);
      groundHits.unshift(
        existingHit || { title: topic, url: originUrl, content: "" }
      );
    }

    sites = sites.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));
    videos = videos.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));

    // 把原报道置顶到对应列表（去掉已存在的同链接项，再 unshift 到最前，标 core:true）。
    if (originUrl) {
      const originLink: Link = {
        title: topic,
        url: originUrl,
        source: sourceOf(originUrl) || (platform || "").toString().trim(),
        core: true,
      };
      if (originIsVideo) {
        videos = [originLink, ...videos.filter((l) => l.url !== originUrl)];
      } else {
        sites = [originLink, ...sites.filter((l) => l.url !== originUrl)];
      }
    }

    // 报道取材：不局限于「核心来源」那 1-3 条，而是尽量多汇集权威来源交叉核对。
    // 从全部文章结果里剔除百科/搜索页与视频，按 (相关性 + 权威加权) 排序取前 8 条，
    // 再把同平台核心来源并进来去重，一起喂给模型，让它有足够素材还原事实真相。
    const reportRanked = general
      .filter((h) => !isVideoUrl(h.url) && !isGenericRef(h.url))
      .map((h) => ({
        h,
        s:
          relevanceScore(`${h.title} ${h.content}`, core) +
          (isAuthoritative(h.url) ? 3 : 0),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.h);
    const reportSeen = new Set<string>();
    const reportHits: SearchHit[] = [];
    for (const h of [...groundHits, ...reportRanked]) {
      if (reportSeen.has(h.url)) continue;
      reportSeen.add(h.url);
      reportHits.push(h);
      if (reportHits.length >= 8) break;
    }

    // 一致性保证：报道是【严格依据 reportHits 这几篇资料】生成的，所以这几篇【必须】全部出现在
    // 用户可见的「参考网站」里，否则会出现"报道引用了参考资料里根本没有的来源（如原帖）"的问题。
    // 这里把 reportHits 里尚未展示的文章补进 sites（保留已算好的相关性排序与 core 标记，缺的追加到末尾）。
    const shownSiteUrls = new Set(sites.map((l) => l.url));
    for (const h of reportHits) {
      if (isVideoUrl(h.url) || shownSiteUrls.has(h.url)) continue;
      shownSiteUrls.add(h.url);
      sites.push({
        title: h.title,
        url: h.url,
        source: sourceOf(h.url),
        core: coreUrls.has(h.url) || undefined,
      });
    }

    // 严格依据搜集到的多篇权威来源生成报道
    const report = await genReport(topic, platform || "", reportHits);

    // 兜底：确实没搜到任何关联内容时才退回搜索页链接
    if (sites.length === 0) {
      sites = [
        { title: `百度搜索：${core}`, url: `https://www.baidu.com/s?wd=${q}`, source: "百度" },
        {
          title: `知乎搜索：${core}`,
          url: `https://www.zhihu.com/search?type=content&q=${q}`,
          source: "知乎",
        },
      ];
    }
    if (videos.length === 0) {
      videos = [
        {
          title: `B站搜索：${core}`,
          url: `https://search.bilibili.com/all?keyword=${q}`,
          source: "哔哩哔哩",
        },
      ];
    }

    // 封闭平台（App 内闭环、爬不到具体内容）——固定追加"站内搜索"跳转入口。
    // 小红书 / 微博 放在参考网站末尾，抖音 放在参考视频末尾。
    sites.push(
      {
        title: `小红书搜索：${core}`,
        url: `https://www.xiaohongshu.com/search_result?keyword=${q}`,
        source: "小红书",
      },
      {
        title: `微博搜索：${core}`,
        url: `https://s.weibo.com/weibo?q=${q}`,
        source: "微博",
      }
    );
    videos.push(
      {
        title: `抖音搜索：${core}`,
        url: `https://www.douyin.com/search/${q}`,
        source: "抖音",
      }
    );

    return NextResponse.json({ report, sites, videos });
  } catch (e: any) {
    return NextResponse.json(
      { report: `详情获取失败：${e.message}`, sites: [], videos: [] },
      { status: 500 }
    );
  }
}

async function genReport(
  topic: string,
  platform: string,
  hits: SearchHit[]
): Promise<string> {
  if (!OPENAI_API_KEY) {
    return `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
  }
  // 用真实搜索到的多篇权威来源当作依据，交叉核对后提炼事实，避免凭空臆测
  const material = hits
    .slice(0, 8)
    .map((h, i) => `【来源${i + 1}｜${sourceOf(h.url)}】${h.title}｜${h.content}`.trim())
    .filter((s) => s.length > 6)
    .join("\n");
  const hasMaterial = material.length > 0;
  const from = platform ? `（来自${platform}热榜）` : "";
  const prompt = hasMaterial
    ? `以下是关于热点话题「${topic}」${from}的多篇真实搜索资料（含多个来源）：\n${material}\n\n请你像记者核实新闻一样，对照这几篇来源交叉比对，提炼出多篇来源【一致确认】的事实，写成一段简明清晰的详细报道，说明这个热点具体指什么、事件的来龙去脉与关键信息。硬性要求：\n1. 只写多篇来源共同支撑、可以确定的事实真相，表述要明确、肯定；\n2. 对于个别来源提到但无法确认、或各来源说法冲突的细节，直接【略去不写】，不要把它写进报道；\n3. 【严禁】出现"资料未明确""尚不可知""无法确认""未提供原文""细节不详"这类含糊、留白的措辞——报道里呈现的每一句都应是已核实的确定信息；\n4. 绝对不得臆测或编造资料中没有的内容；\n5. 【严禁提及上述资料清单之外的任何来源、平台或帖子】——不要写"某贴吧帖子""某讨论帖""可作为……的素材"这类点评式、指向具体出处的话；报道只陈述事件本身，不描述"信息来自哪里"，因为你只能看到上面这几条资料，臆测原始出处会与用户看到的参考链接对不上。\n控制在 200-320 字，中文，客观清晰，直接成段叙述，不要分点、不要加标题、不要罗列来源。`
    : `请就热点话题「${topic}」${from}写一段简明的详细报道，包含事件背景、关键信息、各方观点或影响。若你并不确定该词的确切含义，请说明「暂无足够公开信息」，不要编造，也不要臆测信息来自某个具体帖子或来源。控制在 200-300 字，中文，客观清晰，直接成段叙述。`;
  try {
    const res = await fetchWithTimeout(
      `${OPENAI_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      15000
    );
    const json = await res.json();
    return (
      json.choices?.[0]?.message?.content ||
      `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`
    );
  } catch {
    return `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
  }
}
