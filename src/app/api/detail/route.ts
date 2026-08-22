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

type Link = { title: string; url: string };
type SearchHit = { title: string; url: string; content: string };

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

// 去掉书名号/引号/括号/标点等会干扰搜索分词的符号，得到核心词
const cleanTopic = (t: string) =>
  t
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。.！!？?~—\-]/g, " ")
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
      merged.push({ l: { title: h.title, url: h.url }, s, i: idx++ });
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
    const { topic } = await req.json();
    if (!topic || typeof topic !== "string") {
      return NextResponse.json({ report: "缺少话题信息。", sites: [], videos: [] });
    }
    const core = cleanTopic(topic);
    const q = encodeURIComponent(core);

    // SearXNG 一次 general + 一次 videos 检索 + LLM 报道
    const [general, videoRes, report] = await Promise.all([
      searxSearch(core, "general", 30).catch(() => [] as SearchHit[]),
      searxSearch(core, "videos", 30).catch(() => [] as SearchHit[]),
      genReport(topic),
    ]);

    // 文章：general 结果里排除视频站，排序取前 8 条
    let sites = rankLoose([general.filter((s) => !isVideoUrl(s.url))], core, 8);
    // 视频：videos 分类结果 + general 里命中的视频链接，排序取前 8 条
    let videos: Link[] = rankLoose(
      [videoRes, general.filter((s) => isVideoUrl(s.url))],
      core,
      8
    );

    // 兜底：确实没搜到任何关联内容时才退回搜索页链接
    if (sites.length === 0) {
      sites = [
        { title: `百度搜索：${core}`, url: `https://www.baidu.com/s?wd=${q}` },
        {
          title: `知乎搜索：${core}`,
          url: `https://www.zhihu.com/search?type=content&q=${q}`,
        },
      ];
    }
    if (videos.length === 0) {
      videos = [
        {
          title: `B站搜索：${core}`,
          url: `https://search.bilibili.com/all?keyword=${q}`,
        },
      ];
    }

    return NextResponse.json({ report, sites, videos });
  } catch (e: any) {
    return NextResponse.json(
      { report: `详情获取失败：${e.message}`, sites: [], videos: [] },
      { status: 500 }
    );
  }
}

async function genReport(topic: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    return `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
  }
  try {
    const prompt = `请就热点话题「${topic}」写一段简明的详细报道，包含：事件背景、关键信息、各方观点或影响。控制在 200-300 字，中文，客观清晰，不要使用标题分段，直接成段叙述。`;
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
