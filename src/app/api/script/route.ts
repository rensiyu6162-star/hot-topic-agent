import { NextRequest, NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "deepseek-chat";

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 20000
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

async function callLLM(prompt: string): Promise<string> {
  const res = await fetchWithTimeout(`${OPENAI_BASE_URL}/chat/completions`, {
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
  return (json.choices?.[0]?.message?.content || "").trim();
}

// 各脚本题材的形式要求，让生成结果贴合对应形态且保持简短
const TYPE_GUIDE: Record<string, string> = {
  口播稿:
    "形式为「口播稿」：一段可直接照读的口播文案，口语化、有钩子开头和收尾引导。",
  情景演绎:
    "形式为「情景演绎」：给出分镜/对白脚本，标注场景与人物台词。",
  AI生视频:
    "形式为「AI生视频」：按镜头给出画面描述（可含运镜、字幕提示），便于用 AI 生视频工具逐镜生成。",
};

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { script: "", error: "未配置模型密钥，无法生成脚本。" },
        { status: 500 }
      );
    }
    const body = await req.json();
    const action: string = body?.action || "generate";
    const topic: string = (body?.topic || "").toString().trim();
    const platform: string = (body?.platform || "").toString().trim();
    const report: string = (body?.report || "").toString().trim();
    const type: string = (body?.type || "口播稿").toString().trim();
    const duration: string = (body?.duration || "").toString().trim();
    const wordRange: string = (body?.wordRange || "").toString().trim();
    if (!topic) {
      return NextResponse.json({ script: "", error: "缺少热点信息。" }, { status: 400 });
    }

    const typeGuide = TYPE_GUIDE[type] || TYPE_GUIDE["口播稿"];
    // 时长档位存在时，长度以该时长/字数为准（覆盖题材要求里的固定字数），否则保持简短
    const lengthGuide =
      duration && wordRange
        ? `目标视频时长约${duration}，脚本参考字数 ${wordRange}（口播稿即口播文字量；分镜类脚本请让全部台词/旁白/画面描述的文字总量贴近该区间）。请贴合该时长与字数，不要明显偏短或偏长。`
        : "篇幅务必简短精炼，不要冗长。";
    const from = platform ? `（来自${platform}热榜）` : "";
    const groundBlock = report
      ? `该热点事件网上相关的高热度报道如下，请以此为事实依据，不要编造报道之外的事实：\n${report}`
      : `暂无额外报道资料，请依据这个热点事件本身的常识来创作，不要编造具体的时间地点数字等未知细节。`;

    let prompt = "";
    if (action === "polish") {
      const plot: string = (body?.plot || "").toString().trim();
      if (!plot) {
        return NextResponse.json({ script: "", error: "请先输入剧情内容。" }, { status: 400 });
      }
      prompt = `你是资深短视频编导。请把用户的剧情想法，结合下面的热点事件与相关报道，润色成一段【精简】的剧情梗概，不要写成完整长脚本。
热点事件：「${topic}」${from}
${groundBlock}

用户的剧情想法：
${plot}

要求：
1. 输出一段精简的剧情梗概/故事线，讲清楚主要情节走向即可，篇幅短小，不必凑字数、不必贴合成片时长；
2. 紧扣上面的热点事件，让剧情与该事件真正相关；
3. 保留用户剧情想法里的核心创意，只做润色与结构化，不要跑题；
4. 直接输出剧情正文，不要任何解释、前言、标题或"以下是"之类的话。`;
    } else {
      const script: string = (body?.script || "").toString().trim();
      const embed: string = (body?.embed || "").toString().trim();
      prompt = `你是资深短视频编导。请结合下面的热点事件与相关报道，生成一个对应题材的脚本。
热点事件：「${topic}」${from}
${groundBlock}
${script ? `\n参考剧情（请在此剧情基础上展开成脚本，保留其核心创意）：\n${script}` : ""}
${embed ? `\n请尽量自然地把以下用户希望植入的梗、彩蛋、特定台词或名场面融入脚本中：\n${embed}` : ""}

要求：
1. ${typeGuide}
2. ${lengthGuide}
3. 紧扣上面的热点事件，并结合上面的参考剧情与需要植入的梗/台词/桥段；
4. 直接输出脚本正文，不要任何解释、前言、标题或"以下是"之类的话。`;
    }

    const script = await callLLM(prompt);
    if (!script) {
      return NextResponse.json(
        { script: "", error: "脚本生成失败，请稍后重试。" },
        { status: 502 }
      );
    }
    return NextResponse.json({ script });
  } catch (e: any) {
    return NextResponse.json(
      { script: "", error: `脚本生成失败：${e?.message || e}` },
      { status: 500 }
    );
  }
}
