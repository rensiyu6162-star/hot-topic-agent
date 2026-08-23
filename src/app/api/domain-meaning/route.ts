import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";

// 领域名称 -> 若干候选释义。用户在「添加/编辑领域」弹窗里输入名称并点击「确认」时调用。
// 返回 { options: string[] }，每条是对该领域的一句话释义，供用户选中或自行改写（释义可选）。
export async function POST(req: NextRequest) {
  try {
    const { name } = await req.json();
    const domain = String(name || "").trim();
    if (!domain) {
      return NextResponse.json({ options: [] });
    }
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ options: [], error: "no_key" });
    }

    const sys =
      "你是一个帮助用户明确「内容领域」含义的助手。用户会给你一个领域名称（可能是缩写、圈内黑话、宽泛的行业词或有歧义的词），" +
      "你要给出 3-4 个【不同角度】的简短释义，帮助用户挑选最贴合自己意图的那个。" +
      "要求：\n" +
      "1) 每条释义 15-40 字，用一句话说清这个领域具体指什么、大致覆盖哪些话题；\n" +
      "2) 若名称有歧义或有多种常见理解，就分别对应不同理解各给一条；\n" +
      "3) 释义要具体、可用于判断一条热点是否属于该领域，不要空话套话；\n" +
      '4) 严格只输出 JSON，格式为 {"options": ["释义1", "释义2", "释义3"]}，不要输出任何多余文字。';
    const user = `领域名称：${domain}`;

    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      return NextResponse.json({ options: [], error: "llm_error" });
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    let options: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.options)) {
        options = parsed.options
          .map((x: unknown) => String(x || "").trim())
          .filter((x: string) => x.length > 0)
          .slice(0, 4);
      }
    } catch {
      // 解析失败时按行兜底提取
      options = raw
        .split("\n")
        .map((l: string) => l.replace(/^[\s\-\d.、)）"]+/, "").trim())
        .filter((l: string) => l.length > 0)
        .slice(0, 4);
    }
    return NextResponse.json({ options });
  } catch {
    return NextResponse.json({ options: [], error: "bad_request" });
  }
}
