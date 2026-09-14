// 年龄守卫（方案D·做法2，纯代码零token）：修复"当前年龄"类旧记忆回潮
// （模型把训练语料里过时的"18岁天才"写进新稿，实际人物已19岁）。
//
// 设计红线（用户明确关切）：脚本可能说的是"18岁时夺冠"这类【过去事件】年龄，
// 绝不能误改。因此只处理语法上明确断言【当前年龄】的表述：
//   ① 肯定式哨兵：（现在|今年|刚满|才|年仅|已经）+ 数字 + 岁
//   ② 定语式："N岁的他/她/这位/人/小孩…"（who 表 2026-09 扩容——"18岁的人"
//      "19岁小孩"这类口语画像句此前不在覆盖范围，同稿两种年龄口径就是这么漏的）
// 多重保护：
//   1) 资料里没有出生日期 → 守卫整体不生效（没有真相就不改写）
//   2) 该年龄数字在资料里以【过去叙事】出现过（如"16岁出道"）→ 跳过（资料陈述的合法事实）。
//      注意 2026-09 起不再全量豁免：资料池里的旧帖也会把 19 岁的人喊成"18岁的他"，
//      全量豁免会让过时年龄永远卡死修正；有精确生日在手时，资料里的【当前年龄断言】
//      视为过时信息、照修不误
//   3) 资料只有出生年份没有月日 → 真实年龄有两个可能值，原值在可能集内则不动
//      （此时保守：资料出现过该年龄就不动，不确定不改写）
//   4) 该句带过去锚点（当时/那年/成名/出道/年份…）→ 跳过（历史叙事）
// 生日冲突（2026-09 新增）：跨来源生日说法打架时不再"取第一个"，按同粒度多数票
// 取胜出值（全日期票 > 年月票 > 年份票）。英语生日（born 7 July 2007 /
// born July 7, 2007——Liquipedia/Wikipedia 常见格式）2026-09 起同样识别。
export function fixAgeClaims(
  source: string,
  text: string,
  now: Date = new Date()
): { text: string; fixed: number; birthYear: number | null } {
  const src = source || "";
  const out = text || "";
  if (!src.trim() || !out.trim())
    return { text: out, fixed: 0, birthYear: null };

  // 1) 从资料提取出生日期（多种中文语序 + 英语语序 + 同粒度多数票）：
  //    "2007年1月25日出生"/"2007年1月25号生人"（日期在前，最常见）/
  //    "出生于2007年1月25日"（出生在前）/ "2007年1月出生"（年月）/
  //    "2007年出生"/"出生于2007年"（仅年份）/
  //    "born 7 July 2007"（日 月 年）/ "born July 7, 2007"（月 日， 年）
  const EN_MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const tally = new Map<
    string,
    { n: number; y: number; m: number | null; d: number | null }
  >();
  const add = (y: number, m: number | null, d: number | null, w: number) => {
    if (!y || y < 1900 || y > 2100) return;
    if (m != null && (m < 1 || m > 12)) return;
    if (d != null && (d < 1 || d > 31)) return;
    const k = `${y}-${m ?? ""}-${d ?? ""}`;
    const e = tally.get(k) || { n: 0, y, m, d };
    e.n += w;
    tally.set(k, e);
  };
  for (const re of [
    /(\d{4})年(\d{1,2})月(\d{1,2})[日号]?\s*(?:出?生|生人)/g,
    /出生(?:于|在)?[^\d]{0,6}(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/g,
  ])
    for (const m of src.matchAll(re))
      add(Number(m[1]), Number(m[2]), Number(m[3]), 3);
  for (const m of src.matchAll(/(\d{4})年(\d{1,2})月\s*出生/g))
    add(Number(m[1]), Number(m[2]), null, 2);
  for (const m of src.matchAll(/(?:出生(?:于|在)?[^\d]{0,6})?(\d{4})年出生/g))
    add(Number(m[1]), null, null, 1);
  for (const m of src.matchAll(
    /born\s+(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/gi
  )) {
    const mon = EN_MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) add(Number(m[3]), mon, Number(m[1]), 3);
  }
  for (const m of src.matchAll(
    /born\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/gi
  )) {
    const mon = EN_MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) add(Number(m[3]), mon, Number(m[2]), 3);
  }
  if (!tally.size) return { text: out, fixed: 0, birthYear: null };
  // 同粒度内比票数，粒度从细到粗：全日期 → 年月 → 年份
  const entries = [...tally.values()];
  const pick = (
    has: (e: { m: number | null; d: number | null }) => boolean
  ) => entries.filter(has).sort((a, b) => b.n - a.n)[0];
  const bestFull = pick((e) => e.d != null);
  const bestYm = bestFull ? null : pick((e) => e.d == null && e.m != null);
  const bestYear = bestFull || bestYm ? null : pick(() => true);
  const winner = bestFull || bestYm || bestYear;
  if (!winner) return { text: out, fixed: 0, birthYear: null };
  const by = winner.y;
  const bm = winner.m;
  const bd = winner.d;
  const ty = now.getFullYear();
  if (!by || by < 1900 || by > ty)
    return { text: out, fixed: 0, birthYear: null };

  // 2) 计算真实年龄：有月日→精确值；只有年份→两个可能值
  let exact: number | null = null;
  if (bm && bm >= 1 && bm <= 12) {
    const day = bd && bd >= 1 && bd <= 31 ? bd : 1;
    const passed =
      now.getMonth() + 1 > bm ||
      (now.getMonth() + 1 === bm && now.getDate() >= day);
    exact = ty - by - (passed ? 0 : 1);
  }
  const validSet = new Set<number>(
    exact != null ? [exact] : [ty - by, ty - by - 1]
  );
  const display = exact != null ? exact : ty - by;

  // 3) 句级过去锚点检查（资料与成稿通用）："N岁的他"所在句在讲历史（"15岁的他随队夺
  // 得世少赛冠军"）时绝不能改成真实年龄。命中任意锚点即视为历史叙事，跳过。
  const PAST_RE =
    /当时|那年|当年|此前|曾经|曾在|曾随|曾于|早在|时期|成名|出道|首秀|青训|退役|岁时|\d{4}年/;
  const SENT_END = ["。", "！", "？", "；", "\n"];
  const sentenceAt = (text: string, pos: number) => {
    let start = 0;
    for (const ch of SENT_END) {
      const i = text.lastIndexOf(ch, pos);
      if (i >= start) start = i + 1;
    }
    let end = text.length;
    for (const ch of SENT_END) {
      const i = text.indexOf(ch, pos);
      if (i >= 0 && i < end) end = i;
    }
    return text.slice(start, end);
  };

  // 单个数字的修正判定：本来就对（或年份未知时的合法可能值）→ 不改；
  // 资料出现过该数字 → 只在【过去叙事】用法下不碰（"16岁出道"是合法事实），
  // 资料里的【当前年龄断言】（旧帖"18岁的他"）在精确生日在手时是过时信息，照修。
  const shouldFix = (n: number) => {
    if (!Number.isFinite(n) || n <= 0 || n > 99) return false;
    if (validSet.has(n)) return false;
    let seen = false;
    for (const m of src.matchAll(new RegExp(`${n}\\s*岁`, "g"))) {
      seen = true;
      if (PAST_RE.test(sentenceAt(src, m.index ?? 0))) return false; // 合法过去事实
    }
    if (seen && exact == null) return false; // 只有出生年份时保守：出现过就不动
    return true;
  };

  let fixed = 0;
  // 3a) 肯定式哨兵（现在/今年/刚满/才/年仅/已经）——语法上明确断言当前年龄
  const RE = /(现在|今年|刚满|才|年仅|已经)([0-9]{1,2})岁/g;
  let res = out.replace(RE, (whole, marker: string, num: string, offset: number) => {
    if (PAST_RE.test(sentenceAt(out, offset))) return whole; // 历史叙事句（"那年他才18岁"），不碰
    const n = Number(num);
    if (!shouldFix(n)) return whole;
    fixed++;
    return `${marker}${display}岁`;
  });

  // 3b) 定语式（N岁的他/她/这位/人/小孩/少年/天才/选手…）——只修现在时画像句。
  // "的"可选（2026-09 实测缺口）：成稿里"N岁小孩""N岁少年"这类紧缩词形不带"的"
  // （如"连恋爱都不敢官宣的19岁小孩"），此前漏匹配导致同稿两种年龄口径只修一半。
  const RE2 =
    /([0-9]{1,2})岁的?(他|她|这位|小将|少年|天才|选手|小孩|孩子|男孩|女孩|男生|女生|小伙|姑娘|新人|人)/g;
  res = res.replace(
    RE2,
    (whole, num: string, who: string, offset: number) => {
      // 「不满/未满X岁」不是简单的当前年龄断言：把 N 换成真实年龄会产出假话
      // （19岁的人被写成"不满19岁"）。设计上整体不碰、宁可漏放（测试用例12）。
      if (/^(不满|未满)/.test(out.slice(Math.max(0, offset - 2), offset)))
        return whole;
      if (PAST_RE.test(sentenceAt(out, offset))) return whole; // 历史叙事句，不碰
      const n = Number(num);
      if (!shouldFix(n)) return whole;
      fixed++;
      // 还原原词形："N岁的他"带"的"，"N岁小孩"紧缩式不带
      return whole.startsWith(`${num}岁的`) ? `${display}岁的${who}` : `${display}岁${who}`;
    }
  );

  return { text: res, fixed, birthYear: by };
}
