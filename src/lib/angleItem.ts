// 切入角度条目的「显式检索契约」与角度句清洗（2026-09）。
// 背景：角度行是给用户看的选题切口（自然语言、含日期/平台/元话语），
// 但查看详情要拿它去检索——同一句自然语言兼任两个角色，导致长句/黑话系统性零召回
//（2-3 字圈内黑话被引号取词跳过；"XX向：…可做一期…"整句进引擎）。
// 解法：模型在角度行尾输出机器可读的检索契约 〔搜：词1 词2 词3〕，
// 前端剥掉契约只显示切口，后端拿契约词做多路召回。本文件放三处共用的纯函数：
//   page.tsx（解析/显示/请求）、detail/route.ts（召回/事实门）、评测（复刻同款逻辑，
//   与 quoteGuard 的双份维护口径一致：改规则必须两边同步）。

// 只认 〔〕 与半角 []——【】 是领域胶囊（【女性主义】），不能与检索标记混淆。
export const ANGLE_MARKER_RE =
  /[（(]?\s*〔\s*搜\s*[：:]\s*([^〕]{1,100}?)〕\s*[）)]?|\[\s*搜\s*[：:]\s*([^\]]{1,100}?)\]/;

export interface AngleMarker {
  // 剥掉检索契约后的展示文本（顺手清掉残留的尾随标点/空白）
  display: string;
  // 检索词（已去重、限长）；无契约时为空数组，调用方走启发式兜底
  keywords: string[];
}

function cleanKw(w: string): string {
  return w
    .replace(/[「」『』""''“”‘’﹁﹂﹃﹄《》]/g, "")
    .replace(/[，,。．！？!?；;：:、…—~·*#]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

export function parseAngleMarker(line: string): AngleMarker {
  const s = line || "";
  const m = s.match(ANGLE_MARKER_RE);
  if (!m) return { display: s, keywords: [] };
  const raw = m[1] ?? m[2] ?? "";
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (let piece of raw.split(/[\s,，、;；|｜/]+/)) {
    const kw = cleanKw(piece).slice(0, 12);
    if (kw.length < 2) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(kw);
    if (keywords.length >= 5) break;
  }
  const display = s
    .replace(ANGLE_MARKER_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[，,。．！？!?\s]+$/, "")
    .trimEnd();
  return { display, keywords };
}

// 调用方传入的检索词入参归一（防脏数据/超长/纯数字噪声），与 expandQueries 的
// keywords 门槛同口径：含汉字，或含 ≥2 位字母；2-12 字；最多 5 个。
export function normalizeAngleKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const kw = cleanKw(x).slice(0, 12);
    if (kw.length < 2) continue;
    if (!/[一-龥]/.test(kw) && !/[a-zA-Z]{2,}/.test(kw)) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= 5) break;
  }
  return out;
}

// 角度标签前缀："圈层内讧向：…" / "特质衍生方向：…"——内容中立的句式规则
// （2-10 字标签 + 向/方向 + 冒号），不枚举任何具体标签名。
const ANGLE_LEAD_RE =
  /^\s*(?:[-•·*▪️]\s*)?[一-龥A-Za-z0-9]{2,10}(?:向|方向)\s*[：:]\s*/;

export function stripAngleLead(t: string): string {
  let s = (t || "").trim();
  // 最多剥两轮，防"标签：标签："叠加
  for (let i = 0; i < 2; i++) {
    const n = s.replace(ANGLE_LEAD_RE, "").trim();
    if (n === s) break;
    s = n;
  }
  return s;
}

// 判断一句话题是不是「角度/选题描述句」（而非用户裸搜索词）：
// 含角度标签、"可做（一期）"元话语，或长叙事句里出现选题动词。
export function looksLikeAngleSentence(t: string): boolean {
  const s = t || "";
  if (ANGLE_LEAD_RE.test(s)) return true;
  if (/可做(?:一期|个|条)?|这期|本期选题|切入(?:口|角度)?/.test(s))
    return s.length >= 16;
  return false;
}

// 长引号金句（13-40 字，如「经典我一个bl妹都想反bl了」）超短时引擎照样零召回，
// 但句中【中英混写原子词】（bl妹/反bl）是圈内唯一可索引形态。抽取规则保持内容中立：
// 取拉丁字母串本身，以及与它【紧贴的单个汉字】（功能字"个/的/我"等不贴）。
const QUOTE_ATTACH_STOP = new Set(
  "的了个是我你他她它们都也就还在有和与或而被把让向往对从到啊吗呢吧呀嘛呗哦哈"
    .split("")
);
const LATIN_RUN_RE = /[a-zA-Z][a-zA-Z0-9]*/g;
function quoteAtoms(phrase: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string) => {
    const k = w.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  let m: RegExpExecArray | null;
  while ((m = LATIN_RUN_RE.exec(phrase))) {
    const w = m[0];
    if (w.length >= 2) push(w);
    const i = m.index;
    const before = phrase[i - 1];
    const after = phrase[i + w.length];
    if (before && /[一-龥]/.test(before) && !QUOTE_ATTACH_STOP.has(before))
      push(before + w);
    if (after && /[一-龥]/.test(after) && !QUOTE_ATTACH_STOP.has(after))
      push(w + after);
  }
  return out;
}

// 无契约的旧角度行兜底：收集全部引号短语（含 2-3 字圈内黑话原词）。
// 单个短黑话当整句查询鉴别力不足，但两个以上并列就是强证据组合，交后端逐词 fan-out。
// 长金句（13-40 字）整句不具鉴别力，只抽其中中英混写原子词当原词；整句裸搜由
// heuristicAngleQuotes 另走搜索通道，不进证据词。
export function heuristicAngleKeywords(topic: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (kw: string) => {
    if (kw.length < 2 || kw.length > 12) return;
    const key = kw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(kw);
  };
  const re = /[「“"『]([^」”"』]{2,40})[」”"』]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(topic || ""))) {
    const kw = cleanKw(m[1]);
    if (kw.length < 2) continue;
    if (kw.length <= 12) {
      add(kw);
    } else {
      for (const a of quoteAtoms(kw)) add(a);
    }
    if (out.length >= 6) break;
  }
  return out;
}

// 引号里的长金句原句（13-40 字）：专供【强制裸搜】，不作为事实门证据词
//（整句不会被任何页面逐字转载，当证据词只会关门）。
export function heuristicAngleQuotes(topic: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[「“"『]([^」”"』]{13,40})[」”"』]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(topic || ""))) {
    const kw = cleanKw(m[1]);
    if (kw.length < 13) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= 3) break;
  }
  return out;
}

// 事实门证据词清洗（2026-09）：从角度长句里剥出真正有鉴别力的实词片段。
// 旧口径 factContentParts 只剥通用功能词，但角度句里充斥三类"伪证据词"：
//  ①平台名（微博/知乎/贴吧…）——任何平台讨论帖都会自带平台名，不能证明话题命中；
//  ②选题元话语（特质/衍生/切入/可做/一期/高赞/提问…）——结构词，与话题无关；
//  ③日期残片（9 月/4 日）——日期在角度句里是导语法，不是实体。
// 注意：只做【减法降权】，不新增任何放行通道，宁漏勿纵。
const PLATFORM_WORDS = new Set([
  "微博", "知乎", "贴吧", "百度", "豆瓣", "虎扑", "抖音", "小红书", "快手",
  "头条", "腾讯", "网易", "搜狐", "新浪", "公众号", "微信", "凤凰", "央视",
  "哔哩", "官媒", "外网", "百度知道", "百家号",
]);
const META_WORDS = new Set([
  "特质", "衍生", "切入", "切角", "角度", "方向", "选题", "可做", "一期",
  "这期", "本期", "网友", "高赞", "提问", "各种", "一串", "罗列", "用来",
  "来说", "近期", "最近", "近日", "目前", "看到", "发现", "相关", "内容",
  "讨论", "一个", "这个", "那个", "可以", "他们", "我们", "自己", "大家", "有人", "标签",
  "称呼",
]);

// 在通用片段切分基础上去掉伪证据词。baseParts 由调用方按既有 factContentParts
// 口径切好（保持单一事实源），这里只做集合过滤与日期片段过滤。
const PLATFORM_ALT = [...PLATFORM_WORDS].sort((a, b) => b.length - a.length).join("|");
const PLATFORM_EDGE_RE = new RegExp(`^(?:${PLATFORM_ALT})+|(?:${PLATFORM_ALT})+$`, "g");
export function dropNonEvidenceParts(parts: string[]): string[] {
  return parts.flatMap((p0) => {
    let p = p0.trim();
    if (p.length < 2) return [];
    // 片段首尾常粘着平台名（"知乎9月4日"→剥成"9月4日"再按日期丢掉），最多剥两轮
    p = p
      .replace(PLATFORM_EDGE_RE, "")
      .replace(PLATFORM_EDGE_RE, "")
      .trim();
    if (p.length < 2) return [];
    if (PLATFORM_WORDS.has(p) || META_WORDS.has(p)) return [];
    // 纯日期残片：9月 / 4日 / 13号 / 2026年 / 9月4日
    if (/^(?:(?:19|20)\d{2}年?|\d{1,2}月|\d{1,2}[日号]|\d{1,2}月\d{1,2}[日号]?)$/.test(p))
      return [];
    // 剥完只剩功能字（"的说""来讲"）
    if (!/[一-龥a-zA-Z0-9]/.test(p)) return [];
    return [p];
  });
}
