import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";
// 本地 DailyHotApi 地址（需先部署，见说明）
const DAILYHOT_BASE = process.env.DAILYHOT_BASE_URL || "http://localhost:6688";

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
      const list = json?.data?.items || json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title || item.name || item.word || "未知",
        url: item.url || `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(item.title || item.name || item.word || "")}`,
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
      if (matches.length === 0) throw new Error("empty");
      const unique = [...new Set(matches.map(m => m[1]))];
      return unique.slice(0, 20).map((title: string, i: number) => ({
        rank: i + 1, title,
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(title)}`,
      }));
    },
    async () => {
      // 源3：通过今日头条热榜间接获取（头条覆盖面广，含小红书相关内容）
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/toutiao`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || "",
        note: "数据来源：今日头条热榜（小红书暂无直接接口）",
      }));
    },
  ], "小红书热榜暂时无法获取，建议稍后重试");
}

async function fetchKuaishouHot(): Promise<any[]> {
  return tryFetchSources([
    async () => {
      // 源1：本地 DailyHotApi
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/kuaishou`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || "",
      }));
    },
    async () => {
      // 源2（备用）：百度热搜作为替代
      const res = await fetchWithTimeout(`${DAILYHOT_BASE}/baidu`);
      const json = await res.json();
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, url: item.url || "",
        note: "数据来源：百度热搜（快手接口暂不可用时的替代）",
      }));
    },
  ], "快手热榜暂时无法获取，建议稍后重试");
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
      const list = json?.data || [];
      if (list.length === 0) throw new Error("empty");
      return list.slice(0, 20).map((item: any, i: number) => ({
        rank: i + 1, title: item.title, hot: item.hot || 0, url: item.url || "",
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
  快手: fetchKuaishouHot,
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
            enum: ["微博", "知乎", "B站", "抖音", "小红书", "快手", "头条", "百度"],
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
];
// ========== System Prompt ==========

function buildSystemPrompt(domain: string, platforms: string[]) {
  const domainHint = domain
    ? `用户的创作领域是「${domain}」。`
    : `用户未指定创作领域，如果用户在消息中提到领域相关信息，请据此筛选。`;
  const sortRule = domain
    ? `- ⚠️ 用户已明确领域「${domain}」：展示热点时，务必把与「${domain}」高度相关的热点排在最前面，并在这些条目标题前加 ⭐ 标记；其余热点按原热度顺序排在后面。`
    : `- 用户未明确领域：按平台热度原顺序展示即可，不做重排。`;
  return `你是一个专业的自媒体热点分析 Agent。${domainHint}目标平台是：${platforms.join("、")}。

你的能力：
1. fetch_hot_topics: 从微博、知乎、B站、抖音、小红书、快手、头条、百度抓取实时热点
2. filter_hot_by_domain: 用 AI 判断哪些热点和用户领域相关
3. generate_video_script: 根据热点生成短视频脚本（Hook → 痛点 → 内容 → CTA）

工作流程：
- 用户说"抓热点"时，依次调用各平台的 fetch_hot_topics
- 用户说"筛选"或"相关"时，调用 filter_hot_by_domain，从用户消息中推断领域
- 用户说"生成脚本"或"写脚本"时，调用 generate_video_script
- 你也可以自主判断，一次性完成 抓取→筛选→生成 的完整流程

展示热点的输出规范（每次列出热点都必须遵守）：
- 每一条热点后面都要用【】标注它所属的创作领域标签，可以多标（一条热点可同时属于多个领域）。
- 领域标签从以下集合中选取：科技数码、职场成长、美食探店、娱乐八卦、财经理财、健康养生、教育学习、旅行出行；若都不贴合，可补充一个最贴切的自定义标签。
${sortRule}
- 格式示例：1. ⭐ 某热点标题 【职场成长】【财经理财】

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
      const filterPrompt = `你是领域筛选助手。从以下热点中，选出与「${args.domain || domain}」领域最相关的5个话题。
只返回 JSON 数组，每项包含 rank, title, reason(为什么相关)。

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
    const { messages, domain, platforms } = await req.json();

    if (!OPENAI_API_KEY) {
      return NextResponse.json({
        content: "⚠️ 服务端未配置 OPENAI_API_KEY，请联系管理员。",
        toolLogs: [],
      });
    }

    const systemMsg = {
      role: "system",
      content: buildSystemPrompt(domain, platforms),
    };

    let conversationMessages = [systemMsg, ...messages];
    const toolLogs: string[] = [];
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
        return NextResponse.json({
          content: assistantMessage.content || "完成。",
          toolLogs,
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

        toolLogs.push(`调用 ${fnName}(${fnArgs.platform || fnArgs.topic || ""})`);

        const result = await executeTool(fnName, fnArgs, domain);

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

    return NextResponse.json({
      content: finalMsg || "已完成处理。",
      toolLogs,
    });
  } catch (e: any) {
    return NextResponse.json(
      { content: `服务错误: ${e.message}`, toolLogs: [] },
      { status: 500 }
    );
  }
}