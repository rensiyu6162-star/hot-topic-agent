// 价格数字确定性脱敏（2026-09 评测实证）：大模型对"行业通行价格"（如某类 API 的人民币
// 单价）有极强的参数记忆，即使 prompt 明令"资料没给具体钱数不许写"，报道与口播稿仍会
// 冒出记忆中的价格数字（"每百万Token 4元""四块钱"），并在 detail→script 链路上扩散。
// 后处理规则：文中出现的【人民币金额】（元/块/块钱/人民币，支持阿拉伯与中文数字）若资料
// 原文中没有同一数字金额的出处，一律泛化替换；"每百万Token X元"类 API 单价短语整体替换
// 为"更低的单价"。美元等外币不处理（商品起售价通常是资料核心事实，如 2000 美元起）。
const NUM = String.raw`(?:\d+(?:\.\d+)?|[零一二三四五六七八九十两][零一二三四五六七八九十百千万两]*)`;
// 人民币金额识别。「块」是钱也是量词：「一块儿」（together）、「一块石头/表/蛋糕」
// （量词+名词）都不是价格——要求「块」后必须是显式「钱」、口语零头（四毛/5毛）、
// 句末或非汉字边界，且用零宽断言不吞标点。「元」「人民币」「块钱」无歧义。
const MONEY = String.raw`(?:${NUM}\s*(?:元|人民币|块钱)|${NUM}\s*块\s*[零一二三四五六七八九两\d]\s*[毛角分]|${NUM}\s*块(?=$|[^\u4e00-\u9fa5]))`;
const MONEY_G = new RegExp(MONEY, "g");

function extractGrounded(material: string): Set<string> {
  const grounded = new Set<string>();
  let m: RegExpExecArray | null;
  MONEY_G.lastIndex = 0;
  while ((m = MONEY_G.exec(material || ""))) {
    const num = m[0].match(new RegExp(NUM))?.[0] ?? "";
    if (num) grounded.add(num);
  }
  return grounded;
}

export function redactUngroundedPrices(text: string, material: string): string {
  if (!text) return text;
  const grounded = extractGrounded(material);
  let out = text;
  // 每百万 Token 单价短语（阿拉伯/中文数字都抓，"每"可省略；覆盖两种语序，
  // 含"四块钱一百万Token"这类中间夹"一百万"的口语）
  out = out.replace(
    new RegExp(`(?:每\\s*)?百万\\s*[Tt]okens?\\s*${NUM}\\s*(?:元|块钱?|人民币)`, "g"),
    "更低的单价"
  );
  out = out.replace(
    new RegExp(
      `${NUM}\\s*(?:元|块钱?|人民币)\\s*(?:/|每)?\\s*(?:[一二两\\d]?百万\\s*)?[Tt]okens?`,
      "g"
    ),
    "更低的单价"
  );
  // 其余无出处的人民币金额。量词用法（一块儿/一块+n.）已由 MONEY 的边界约束排除。
  out = out.replace(MONEY_G, (full) => {
    const num = full.match(new RegExp(NUM))?.[0] ?? "";
    return grounded.has(num) ? full : "更低的价格";
  });
  // 替换病句清理（2026-09 评测实证）：金额被泛化成"更低的价格"后，若它落在
  // "是/就是/为/达到/有/相当于"这类判断动词后（原句在断言一个具体金额，如
  // "光国家基础补贴就是更低的价格"），留下的是主谓搭配崩坏的残句。整小句删除
  // （按逗号/分号/句末标点切分），比发出病句安全；"用更低的价格买到…"这类
  // 介宾正常搭配不在删除模式内。
  out = out
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[，,；;。．！？!?])/)
        .filter((seg) => !/(?:是|就是|为|达|达到|有|相当于|等于|要)\s*更低的(?:价格|单价)/.test(seg))
        .join("")
    )
    .join("\n")
    .replace(/[，,；;]\s*([。．！？])/g, "$1")
    .replace(/([，,。．！？；;])\1+/g, "$1")
    .replace(/^[，,。．；;\s]+/gm, "");
  return out;
}
