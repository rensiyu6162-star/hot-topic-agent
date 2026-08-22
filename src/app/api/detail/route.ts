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

// Bing 的结果链接常被包成跳转 https://www.bing.com/ck/a?...&u=a1<base64url>
// 需要从 u 参数取出 a1 后的 base64url 解码还原真实地址
function resolveBingUrl(raw: string): string | null {
  const url = raw.replace(/&amp;/g, "&");
  if (!/^https?:\/\//.test(url)) return null;
  if (!/bing\.com\/ck\//.test(url)) return url; // 非跳转链接，直接返回
  const m = url.match(/[?&]u=([^&]+)/);
  if (!m) return null;
  let token = decodeURIComponent(m[1]);
  if (token.startsWith("a1")) token = token.slice(2);
  // base64url -> base64
  token = token.replace(/-/g, "+").replace(/_/g, "/");
  while (token.length % 4) token += "=";
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    return /^https?:\/\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// 抓取 Bing 网页搜索结果，解析出真实文章链接
async function bingSearch(query: string, limit: number): Promise<Link[]> {
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`,
    { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" } }
  );
  const html = await res.text();
  const results: Link[] = [];
  const seen = new Set<string>();
  const re =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < limit) {
    const url = resolveBingUrl(m[1]);
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (!title || !url || /bing\.com\/aclick/.test(url) || seen.has(url))
      continue;
    seen.add(url);
    results.push({ title, url });
  }
  return results;
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

// 相关性打分：标题与话题的 2-gram 重合数（完整命中额外加权）。仅用于排序，不作硬性过滤
function relevanceScore(title: string, topic: string): number {
  const t = title.replace(/\s+/g, "");
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

// 汇总去重 + 剔除百科/搜索页 + 按相关性排序（Bing 原序作为同分次序），取前 limit 条
function rankLoose(lists: Link[][], topic: string, limit: number): Link[] {
  const seen = new Set<string>();
  const merged: { l: Link; s: number; i: number }[] = [];
  let idx = 0;
  for (const list of lists) {
    for (const l of list) {
      if (seen.has(l.url) || isGenericRef(l.url)) continue;
      seen.add(l.url);
      merged.push({ l, s: relevanceScore(l.title, topic), i: idx++ });
    }
  }
  return merged
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

    // 多路检索取更多关联内容 + LLM 报道
    const [siteA, siteB, vidBili, vidGeneral, report] = await Promise.all([
      bingSearch(core, 20).catch(() => [] as Link[]),
      bingSearch(`${core} 事件`, 20).catch(() => [] as Link[]),
      bingSearch(`${core} site:bilibili.com`, 20).catch(() => [] as Link[]),
      bingSearch(`${core} 视频`, 20).catch(() => [] as Link[]),
      genReport(topic),
    ]);

    // 文章：排除视频站，汇总去重+排序，取前 8 条
    let sites = rankLoose(
      [siteA, siteB].map((l) => l.filter((s) => !isVideoUrl(s.url))),
      core,
      8
    );
    // 视频：只保留真实视频页链接，汇总去重+排序，取前 8 条
    let videos: Link[] = rankLoose(
      [vidBili, vidGeneral].map((l) => l.filter((v) => isVideoUrl(v.url))),
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
