import { NextRequest, NextResponse } from "next/server";
import { searxSearch } from "../../../lib/searx";
import { getLlm, isInternalRequest, resolveRequestLlm, setRequestLlm } from "../../../lib/llm";

// 自建 SearXNG（部署在腾讯云 VPS）——用于联网检索"识别不出"的新黑话/圈内词。
// 纯靠模型自身知识无法覆盖训练截止后才流行的平台黑话（如抖音/小红书新梗），
// 所以先联网搜这个词的近期用法，把摘要喂给模型，再让它据此总结释义。
// 检索实现已抽到 @/lib/searx 共享模块（12s 超时 + 空结果换词重试 + 10min 缓存）。

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 9000
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

// 联网检索该词的解释/用法，返回若干条 {title, content} 摘要供模型参考。
async function searchSlangMeaning(
  domain: string,
  limit = 8
): Promise<{ title: string; content: string; url: string }[]> {
  // 组合查询：直接问含义 + 带上平台语境，最大化命中新黑话的解释类页面。
  const query = `${domain} 是什么意思 网络热词 抖音 小红书`;
  const hits = await searxSearch(query, { limit });
  return hits.map((h) => ({ title: h.title, content: h.content, url: h.url }));
}

// 领域名称 -> 若干候选释义。用户在「添加/编辑领域」弹窗里输入名称并点击「识别含义」时调用。
// 返回 { options: string[] }，每条是对该领域的一句话释义，供用户选中或自行改写（释义可选）。
export async function POST(req: NextRequest) {
  try {
    const { name, llm: rawLlm } = await req.json();
    // 绑定本请求的 LLM 配置（强制 BYOK：访客自带 Key；仅内部调用可用系统 Key）
    setRequestLlm(resolveRequestLlm(rawLlm, isInternalRequest(req)));
    const domain = String(name || "").trim();
    if (!domain) {
      return NextResponse.json({ options: [] });
    }
    if (!getLlm().apiKey) {
      return NextResponse.json({ options: [], error: "no_key" });
    }

    // 先联网检索这个词的近期用法/解释（识别新黑话的关键）。搜不到也不报错，退回纯模型知识。
    const hits = await searchSlangMeaning(domain);
    const webContext = hits.length
      ? hits
          .map(
            (h, i) =>
              `${i + 1}. ${h.title}${h.content ? "：" + h.content : ""}`
          )
          .join("\n")
      : "";

    const sys =
      "你是一个帮助用户明确「内容领域」含义的助手。用户会给你一个领域名称（可能是缩写、圈内黑话、平台新梗、宽泛的行业词或有歧义的词），" +
      "你要给出 3-4 个【不同角度】的简短释义，帮助用户挑选最贴合自己意图的那个。" +
      (webContext
        ? "\n下面提供了从互联网检索到的关于该词的资料摘要，请【优先据此】判断它当下的真实含义（尤其是抖音/小红书等平台的网络黑话，你的记忆可能滞后，以检索资料为准）：\n" +
          webContext +
          "\n"
        : "") +
      "要求：\n" +
      "1) 每条释义 15-40 字，用一句话说清这个领域具体指什么、大致覆盖哪些话题；\n" +
      "2) 若名称有歧义或有多种常见理解，就分别对应不同理解各给一条；\n" +
      "3) 释义要具体、可用于判断一条热点是否属于该领域，不要空话套话；\n" +
      (webContext
        ? "4) 请充分利用上面的检索资料，只要资料里能看出含义就【务必】给出释义，不要因为“不是常识词”就返回空；确实完全无从判断时才返回空数组；\n"
        : "4) 若你确实不了解这个词，可基于构词、字面和常见语感给出可能的释义（并覆盖不同理解），尽量不要返回空数组；\n") +
      '5) 严格只输出 JSON，格式为 {"options": ["释义1", "释义2", "释义3"]}，不要输出任何多余文字。';
    const user = `领域名称：${domain}`;

    const llm = getLlm();
    const resp = await fetchWithTimeout(
      `${llm.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
      },
      20000
    );

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
