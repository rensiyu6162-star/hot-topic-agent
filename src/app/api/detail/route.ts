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
    const { topic, platform } = await req.json();
    if (!topic || typeof topic !== "string") {
      return NextResponse.json({ report: "缺少话题信息。", sites: [], videos: [] });
    }
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
    sites = sites.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));
    videos = videos.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));

    // 严格依据核心来源资料生成报道
    const report = await genReport(topic, platform || "", groundHits);

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
  // 用真实搜索到的核心来源当作依据，避免模型对生僻词/网络热词凭空臆测
  const material = hits
    .slice(0, 6)
    .map((h, i) => `${i + 1}. ${h.title}｜${h.content}`.trim())
    .filter((s) => s.length > 3)
    .join("\n");
  const hasMaterial = material.length > 0;
  const from = platform ? `（来自${platform}热榜）` : "";
  const prompt = hasMaterial
    ? `以下是关于热点话题「${topic}」${from}的真实搜索资料（核心来源）：\n${material}\n\n请严格依据上述资料写一段简明的详细报道，说明这个热点具体指什么、事件背景与关键信息。要求：只使用资料中确有的信息，不得臆测或编造；若资料相互矛盾或信息不足，如实说明。控制在 200-300 字，中文，客观清晰，直接成段叙述，不要分点或加标题。`
    : `请就热点话题「${topic}」${from}写一段简明的详细报道，包含事件背景、关键信息、各方观点或影响。若你并不确定该词的确切含义，请说明「暂无足够公开信息」，不要编造。控制在 200-300 字，中文，客观清晰，直接成段叙述。`;
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
