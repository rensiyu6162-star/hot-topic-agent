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
// 没禁止"按资料来源逐条报幕"，成品变成"X月X日某平台有个帖子…后来又有个回答说…"。
export const INFO_NARRATIVE_RULE = `- 【按信息点叙事，禁止资料报幕】把资料当食材而不是菜单：按"发生了什么 → 怎么回事/各方怎么说 → 现在到哪了"组织叙事，同一信息点可以融合多个来源；【严禁】"X月X日某平台有个帖子说……后来又有个回答说……"这种按日期、按平台逐条报账的写法（日期只有在"时间先后本身就是关键信息"时才允许出现，且不超过两处）；
- 每引一个资料细节，后面立刻接一句"这说明了什么/为什么值得讲"，不许把资料摘要原样堆完就结束；`;

// ───────── 资讯稿事实纪律（两个写稿入口共用同一份，禁止再各写各的导致漂移） ─────────

// 今天（北京时间）。容器默认 UTC，直接 toISOString 在晚间会差一天。
export function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 时态纪律：进行中的事件不许写成已结束（2026-09 周琦案"刚结束的亚运会"实锤）。
// 用函数而非常量：容器常驻进程，常量会在模块加载时把日期冻结，跨午夜即过期。
export function factTenseRule(): string {
  return `时态不许反：资料里"将于/刚开始/进行中"的事件，绝不能写成"已结束/刚结束/落幕"；今天是${todayBeijing()}（北京时间），按资料日期推断事件处于哪个阶段就写哪个阶段，资料没说结束就不许写结束`;
}

// 引语纪律：转述不许包装成直接引语。
export const FACT_QUOTE_RULE = `引语不许造假：引号内或冒号后的直接引语必须是资料原句；只拿到大意时一律写成转述（"他表示/公开表态大意是"），禁止给转述配上引号、禁止替人物造句`;

// 钩子位引语纪律（2026-09 健身房案）：模型为满足"开头用原话"把间接陈述改写成第一人称
// 引语（"他要求对方道歉"→"他让我公开道歉"），在无归属钩子位颠倒了冲突双方的诉求方向。
export const HOOK_QUOTE_RULE = `开头若用引号直接引语，必须是资料里逐字找得到的当事人原话；资料只有间接陈述（"他要求X道歉""她回应称……"）时，【严禁】改写成第一人称直接引语；引语必须让听众立刻知道是谁说的；冲突双方各有对立诉求时，不许截取单方诉求做成无归属的开头钩子`;

// chat 写稿工具用的内联版（嵌入编号条款的一句话）。
export function infoFactDiscipline(): string {
  return `稿中所有具体事实（数字/价格/日期/人名/机构名/引语/现场反应）必须能在上面资料里找到原句依据，资料没写的一个字都不许补；禁止脑补现场细节、网友反应、精确数字和历史对比；${factTenseRule()}；${FACT_QUOTE_RULE}`;
}

// /api/script 资讯稿末尾"交稿前终检"块：动作化倒查 + 时态/引语 + 信息块预算。
// 与 chat 的 infoFactDiscipline() 同源，只是语气是"交稿前逐条做"。
export function buildInfoFactTail(midWords: number): string {
  return (
    `\n【事实终检·交稿前必做】把稿中每一个数字、百分比、年份、时长（X年/X个月/X天）、人名机构名、平台榜单名、引语，回到上面资料里逐条找原句；找不到原句的那一句立刻整句删掉，不许换个模糊说法留下。` +
    `\n${factTenseRule()}。` +
    `\n${FACT_QUOTE_RULE}。` +
    (midWords
      ? `\n【信息块预算·硬约束】全稿约${midWords}字最多讲${midWords < 300 ? 3 : 4}个信息块：同类并列（各地政策/各家公司产品/多名网友反应）最多写2个例子；操作流程只留用户最需要的第一步，其余一句话带过或不写；超出预算的信息块【整块不写】，不许靠缩短句子硬塞。`
      : "")
  );
}
