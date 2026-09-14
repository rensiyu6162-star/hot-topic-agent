// 直接引语出处守卫（2026-09 健身房案实锤）：资料是【间接陈述】（"朱店长要求对方公开
// 道歉"）时，模型会在钩子位把它改写成第一人称直接引语（"他让我公开道歉。"），这句话
// 任何当事人都没说过，且无归属地放在开头会颠倒冲突双方的诉求方向。prompt 的"引语不许
// 造假"是软约束，钩子"必须用原话开场"的要求反而激励模型拟一句引语——必须代码兜底。
//
// 规则：
// 1. 抽出成稿中所有成对引号内的直接引语；
// 2. 逐句回资料做归一化子串 / 高重叠匹配，找不到原句出处的即"伪引语"；
// 3. 钩子位（第一句内）的伪引语连同"某某说："前缀整段删除——钩子宁可平实不可造假；
//    正文位置的伪引语只去引号降级为间接叙述，不删内容。
// 纯函数零 token，两个写稿入口共用。

const QUOTE_PAIRS: [string, string][] = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
  ['"', '"'],
];

// 言说动词前缀：删钩子伪引语时把"谢女士说："一起带走，避免留下残句。
const SAY_VERB =
  "(?:说(?:过|道)?|表示|称|坦言|直言|回应|反问|质问|劝|骂|喊|认为|强调|指出|回应称|坦言称)";

function norm(s: string): string {
  return (s || "").replace(/[\s\p{P}\p{S}]/gu, "");
}

// 字符 bigram Dice 系数：允许口播稿对原话做极小改动（"我也需要她公开道歉"vs
// "我需要她给我公开道歉"），但对改写式拟句（"他让我公开道歉"）给低分。
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bg = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = bg(a);
  const B = bg(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// 引语在资料里是否有原话出处。
export function isQuoteGrounded(quote: string, material: string): boolean {
  const q = norm(quote);
  if (q.length < 2) return true; // 单字/语气词不判
  const m = norm(material || "");
  if (!m) return false;
  if (m.includes(q)) return true;
  // 短引语（≤6字）只认子串：相似度对短串过松，"道歉""公开道歉"这种词在新闻里必然出现，
  // 不能因为词出现就认定整句引语有出处。
  if (q.length <= 6) return false;
  // 长引语：在资料中以引语首二字定位候选窗口，比全滑窗便宜得多。
  const head = q.slice(0, 2);
  let from = m.indexOf(head);
  const SIM = 0.72;
  while (from !== -1) {
    for (const len of [q.length, q.length - 2, q.length + 2, q.length - 4, q.length + 4]) {
      if (len > 3 && dice(q, m.slice(from, from + len)) >= SIM) return true;
    }
    from = m.indexOf(head, from + 1);
  }
  return false;
}

interface QuoteHit {
  open: string;
  close: string;
  start: number; // 左引号位置
  end: number; // 右引号位置（含）
  inner: string;
}

function extractQuotes(text: string): QuoteHit[] {
  const hits: QuoteHit[] = [];
  for (const [op, cl] of QUOTE_PAIRS) {
    let i = 0;
    while (i < text.length) {
      const s = text.indexOf(op, i);
      if (s === -1) break;
      const e = text.indexOf(cl, s + 1);
      if (e === -1) break;
      const inner = text.slice(s + 1, e).trim();
      i = e + 1;
      // 过滤明显不是引语的：过短（≤3字多半是强调词如"任意拓扑"）、跨行、超长（成段抄录）
      if (inner.length < 4 || inner.length > 80 || inner.includes("\n")) continue;
      // 与已登记区间重叠则跳过（不同引号体系可能重复匹配同一段）
      if (hits.some((h) => s < h.end && e > h.start)) continue;
      hits.push({ open: op, close: cl, start: s, end: e, inner });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

export interface QuoteGuardResult {
  text: string;
  dropped: number; // 钩子位整段删除的伪引语数
  unquoted: number; // 正文去引号降级数
}

export function guardQuotes(text: string, material: string): QuoteGuardResult {
  if (!text) return { text, dropped: 0, unquoted: 0 };
  const hits = extractQuotes(text);
  if (!hits.length) return { text, dropped: 0, unquoted: 0 };
  // 第一句边界：首个句末标点位置
  const firstStop = text.search(/[。．！？!?]/);
  let dropped = 0;
  let unquoted = 0;
  // 从后往前替换，避免位移
  let out = text;
  for (let k = hits.length - 1; k >= 0; k--) {
    const h = hits[k];
    if (isQuoteGrounded(h.inner, material)) continue;
    const inHook = firstStop === -1 || h.start <= firstStop;
    if (inHook) {
      // 删整个引语小句：向前吃掉"某某说/表示/回应："前缀（本小句范围内），向后吃掉
      // 引语内/外紧邻的句末标点与一个停顿，防止留下"谢女士说。浙江…"这类残句。
      let ls = h.start;
      const before = out.slice(0, h.start);
      const pm = before.match(
        new RegExp(`([^。．！？!?，,；;\\n]{0,12}?${SAY_VERB}[：:]?)$`)
      );
      if (pm) ls = h.start - pm[0].length;
      let re = h.end + 1;
      if (/[。．！？!?，,；;”"』」]/.test(out[re] ?? "")) re += 1;
      out = (out.slice(0, ls) + out.slice(re)).replace(/^[，,\s]+/, "");
      dropped++;
    } else {
      // 正文位：去引号降级为间接叙述（内容保留，归属由上下文承载）
      out = out.slice(0, h.end) + out.slice(h.end + 1);
      out = out.slice(0, h.start) + out.slice(h.start + 1);
      unquoted++;
    }
  }
  // 创口清理
  out = out
    .replace(/[，,]{2,}/g, "，")
    .replace(/[，,]\s*([。．！？!?])/g, "$1")
    .replace(/^[，,\s]+/gm, "")
    .replace(/([。．！？!?])\1+/g, "$1");
  return { text: out.trim(), dropped, unquoted };
}
