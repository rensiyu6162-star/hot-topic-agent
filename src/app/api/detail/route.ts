import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";

// 针对单个热点话题，生成详细报道 + 参考网站 / 参考视频链接
export async function POST(req: NextRequest) {
  try {
    const { topic } = await req.json();
    if (!topic || typeof topic !== "string") {
      return NextResponse.json({
        report: "缺少话题信息。",
        sites: [],
        videos: [],
      });
    }

    const q = encodeURIComponent(topic);
    const sites = [
      { title: `百度搜索：${topic}`, url: `https://www.baidu.com/s?wd=${q}` },
      {
        title: `知乎搜索：${topic}`,
        url: `https://www.zhihu.com/search?type=content&q=${q}`,
      },
      { title: `微博搜索：${topic}`, url: `https://s.weibo.com/weibo?q=${q}` },
    ];
    const videos = [
      {
        title: `B站视频：${topic}`,
        url: `https://search.bilibili.com/all?keyword=${q}`,
      },
      {
        title: `抖音视频：${topic}`,
        url: `https://www.douyin.com/search/${q}`,
      },
    ];

    let report = "";
    if (OPENAI_API_KEY) {
      const prompt = `请就热点话题「${topic}」写一段简明的详细报道，包含：事件背景、关键信息、各方观点或影响。控制在 200-300 字，中文，客观清晰，不要使用标题分段，直接成段叙述。`;
      const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json();
      report = json.choices?.[0]?.message?.content || "";
    }
    if (!report) {
      report = `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
    }

    return NextResponse.json({ report, sites, videos });
  } catch (e: any) {
    return NextResponse.json(
      { report: `详情获取失败：${e.message}`, sites: [], videos: [] },
      { status: 500 }
    );
  }
}
