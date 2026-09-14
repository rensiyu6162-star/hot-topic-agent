// 写稿意图识别与共用纪律块（/api/script 弹窗生成与 /api/chat 的脚本工具共用）。
//
// 为什么要有这个模块（2026-09 用户实锤事故）：旧机制用"梗概框去空白≥12字"判断
// 用户要不要写观点稿——观点一旦填进「植入梗」框、或先点了"润色梗概"被磨成中立
// 提纲，观点稿模式就漏判：系统按资讯稿写，触发料薄降档，产出"X月X日某平台有帖"
// 的资料流水账，用户的主张被当成一句"植入梗"生硬塞进中段。
//
// 修法是【内容中立的结构机制】（用户铁律）：不看输入框位置、不数关键词，让模型
// 判断"用户是否在表达一个需要论证的主观主张"，对任何领域一视同仁；分类失败 fail-open
// 回退到旧的字数启发式，绝不因技术故障阻塞写稿。
export type ScriptIntent = {
  // opinion=观点评论稿（用户给了要捍卫的主张）；info=资讯/讲解稿
  mode: "opinion" | "info";
  // opinion 时：用户主张的原义保真一句话（不改锋利、不中立化、不补事实）
  thesis: string;
  // 输入里属于"素材/梗/原话片段"而非主张的内容，逐条原样保留，供当素材用
  embedBits: string[];
};

export type IntentInput = {
  plot?: string;
  embed?: string;
};

// 纯启发式回退（LLM 分类失败/不可用时）：梗概框有实质内容就按观点稿走（旧行为），
// 植入框内容一律当素材。宁可多走观点稿（用户想法被当主线），也不把主张降级成资讯。
export function heuristicIntent(input: IntentInput): ScriptIntent {
  const plot = (input.plot || "").trim();
  const embed = (input.embed || "").trim();
  const embedBits = embed ? embed.split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean) : [];
  if (plot.replace(/\s+/g, "").length >= 12) {
    return { mode: "opinion", thesis: plot, embedBits };
  }
  return { mode: "info", thesis: "", embedBits };
}

// LLM 意图分类。llm：由调用方注入的"给 prompt 返回文本"函数（与 templates.ts 同口径）。
// 分类与资料抓取/模板召回并行执行，不额外增加串行延迟；任何异常都静默回退启发式。
export async function classifyScriptIntent(
  input: IntentInput,
  llm: (prompt: string) => Promise<string>
): Promise<ScriptIntent> {
  const plot = (input.plot || "").trim();
  const embed = (input.embed || "").trim();
  // 两个框都空：无需分类
  if (!plot && !embed) return { mode: "info", thesis: "", embedBits: [] };
  // 短到没有判断价值：直接启发式，省一次调用
  if (plot.replace(/\s+/g, "").length < 12 && embed.replace(/\s+/g, "").length < 8) {
    return heuristicIntent(input);
  }
  const prompt = `你在判断一个短视频创作者在脚本生成弹窗里填写的内容属于哪种创作意图。只做判断，不写稿、不评价对错。

【用户在"故事梗概/我的想法"框填写】
${plot ? `「${plot}」` : "（空）"}

【用户在"希望植入的梗/台词"框填写】
${embed ? `「${embed}」` : "（空）"}

判断规则（对任何题材、任何领域一视同仁，只看言语行为类型）：
- opinion：用户对一件【有争议、可站队】的事给出了自己的主观判断、因果归因或评价（哪怕只有一句、哪怕写在"植入梗"框里），他要的是"把这个主张论证清楚"。标志：句子在回答"你怎么看/为什么/这说明什么"，且换个人可以不同意它。
- info：用户没有给出要捍卫的主张，只是在罗列事实素材、信息点、原话/梗、创作要求，或给了一段中立的提纲（"梳理一下……的来龙去脉/讲讲……是怎么回事"也算 info）。

只返回一个 JSON 对象，不要解释、不要 markdown 代码块：
{"mode":"opinion 或 info","thesis":"opinion 时：用用户原义把核心主张重述成一句锋利、完整、可直接当全稿主线的话，不许把它改温和/改中立/和稀泥，也不许加入用户没说的事实；info 时为空字符串","embedBits":["把两份输入中属于'素材/梗/原话片段/信息点'而【不是】主张的内容，逐条原样放进数组（不要改写）；若整段输入都是主张或没有素材，返回空数组"]}`;
  try {
    const raw = await llm(prompt);
    const txt = String(raw)
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return heuristicIntent(input);
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const mode = obj.mode === "opinion" ? "opinion" : "info";
    const thesis =
      mode === "opinion" && typeof obj.thesis === "string"
        ? obj.thesis.trim()
        : "";
    const bits = Array.isArray(obj.embedBits)
      ? (obj.embedBits as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
    // 模型判了 opinion 却没抽出主张：回退用梗概/植入原文兜底，绝不允许"主张丢失"
    if (mode === "opinion" && !thesis) {
      return { mode: "opinion", thesis: plot || embed, embedBits: bits };
    }
    // info 模式下若模型没还回任何素材，保守保留原植入框内容，避免素材凭空消失
    if (mode === "info" && bits.length === 0 && embed) {
      return {
        mode: "info",
        thesis: "",
        embedBits: embed.split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean),
      };
    }
    return { mode, thesis, embedBits: bits };
  } catch (e) {
    console.warn(
      "[scriptIntent] 意图分类失败，回退启发式:",
      (e as Error)?.message || e
    );
    return heuristicIntent(input);
  }
}

// ───────── 共用写稿纪律块（两处写稿入口必须同口径，禁止再次漂移） ─────────

// 观点稿的"论证自由 vs 硬事实"边界（2026-09 实测脑补事故反推）：
// 观点稿放开了因果推演/心理分析/类比后，模型会越界两类硬伤——
// ①把资料里的残缺原话（省略号、"没说完"）自行补全成完整断言；
// ②推演时给"具体平台/榜单/数字/群体规模/场景"安上资料里不存在的实体和数值。
export const OPINION_FACT_BOUNDARY = `- 【残句不许补全】资料里被截断、没说完的话（带省略号或明显残缺的原话），引用时只能原样引用残缺的部分，【严禁】凭语感把它补全成一句完整断言或补上来源没说的后半句；
- 【推演不许落地成假事实】因果推演、群体心理分析、生活类比可以放开写，但一旦要落到具体的平台名、榜单、排名、数字、群体规模、时间、人名机构名、"有人说/某帖写到"的场景，资料里没有原句就【一个字都不许编】；需要举例又没有真素材时，只能用"假如/比如说"开头的泛称假设（不出现真实平台名和数字），并让观众一听就知道这是假设；
- 【资料里的态度不许拔高】资料只说"有人讨论/有人提问"，就不能写成"全网炸了/众怒/一边倒"；反应多大，只按资料原话的分量写。`;

// 资讯稿的叙事纪律（2026-09 "帖子流水账"事故反推）：旧 prompt 只要求事实零编造，
// 没禁止"按资料来源逐条报幕"，成品变成"X月X日某平台有个帖子…后来又有个回答…"。
export const INFO_NARRATIVE_RULE = `- 【按信息点叙事，禁止资料报幕】把资料当食材而不是菜单：按"发生了什么 → 怎么回事/各方怎么说 → 现在到哪了"组织叙事，同一信息点可以融合多个来源；【严禁】"X月X日某平台有个帖子说……后来又有个回答说……"这种按日期、按平台逐条报账的写法（日期只有在"时间先后本身就是关键信息"时才允许出现，且不超过两处）；
- 每引一个资料细节，后面立刻接一句"这说明了什么/为什么值得讲"，不许把资料摘要原样堆完就结束；`;
