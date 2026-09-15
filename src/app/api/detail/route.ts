import { NextRequest, NextResponse } from "next/server";
import {
  searxSearch as searxSearchLib,
  searxSearchUnion,
} from "../../../lib/searx";
import { crawlerSearch } from "../../../lib/crawler";
import { flashNewsSearch } from "../../../lib/flashNews";
import { getLlm, isInternalRequest, LlmApiError, llmChatJson, llmErrorAction, resolveRequestLlm, setRequestLlm } from "../../../lib/llm";
import { fixAgeClaims } from "../../../lib/ageGuard";
import { redactUngroundedPrices } from "../../../lib/priceGuard";
import { biliSearchVideos, biliVideoDates } from "../../../lib/bili";
import { queryPlan, sanitizeEntityCandidate } from "../../../lib/relevance";
import {
  dropNonEvidenceParts,
  heuristicAngleKeywords,
  looksLikeAngleSentence,
  normalizeAngleKeywords,
  stripAngleLead,
} from "../../../lib/angleItem";

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 7000
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

type Link = {
  title: string;
  url: string;
  source: string;
  core?: boolean;
  search?: boolean;
  date?: string; // YYYY-MM-DD，来自检索引擎的 publishedDate（部分来源缺失则不标）
  // 搜索引擎快照摘要（≤150字）。参考列表展示不用，但写稿链路靠它兜底：
  // 原文抓不到的封闭平台（知乎/贴吧/小红书…）至少还有这一段可用。
  snippet?: string;
};
type SearchHit = { title: string; url: string; content: string; published?: string };

// 爬虫命中 → 检索命中：微博/贴吧/知乎的平台内讨论（吹颜值的/喷实力的/近况闲聊）
// 是通用搜索引擎索引不到的盲区，detail 召回把它作为与 searx 平级的一路来源
const crawlerToHits = (
  hs: Awaited<ReturnType<typeof crawlerSearch>>
): SearchHit[] =>
  hs.map((h) => ({
    title: h.title,
    url: h.url,
    content: h.content,
    ...(h.published ? { published: h.published } : {}),
  }));

// 同 URL 合并去重（2026-09 贴吧时间戳根治·泛化）：同一条帖子常被 searx 与平台内爬虫
// 同时召回，"先到先得"式去重会让带日期的爬虫命中被先入库的无日期 searx 命中挤掉——
// 参考列表里"贴吧帖明明有时间却没时间戳"就是这么漏的（贴吧时间由爬虫服务提取，
// searx 摘要里没有）。重复 URL 不丢弃：缺日期补日期，缺正文补正文。
function mergeHits(base: SearchHit[], extra: SearchHit[]) {
  const byUrl = new Map(base.map((h) => [h.url, h]));
  for (const h of extra) {
    const prev = byUrl.get(h.url);
    if (prev) {
      if (!prev.published && h.published) prev.published = h.published;
      if (!prev.content && h.content) prev.content = h.content;
      continue;
    }
    byUrl.set(h.url, h);
    base.push(h);
  }
}

// 从 URL 提取来源标签：常见站点给中文友好名，其余显示去掉 www 的主域名
const SOURCE_NAMES: [RegExp, string][] = [
  [/tieba\.baidu\.com/, "百度贴吧"],
  [/zhidao\.baidu\.com/, "百度知道"],
  [/baijiahao\.baidu\.com|baidu\.com/, "百家号"],
  [/zhihu\.com/, "知乎"],
  [/wenku\.so\.com|so\.com/, "360文库"],
  [/bilibili\.com|b23\.tv/, "哔哩哔哩"],
  [/douyin\.com|iesdouyin\.com/, "抖音"],
  [/xiaohongshu\.com|xhslink\.com/, "小红书"],
  [/v\.qq\.com/, "腾讯视频"],
  [/ixigua\.com/, "西瓜视频"],
  [/youtube\.com|youtu\.be/, "YouTube"],
  [/weixin\.qq\.com|mp\.weixin/, "微信公众号"],
  [/toutiao\.com/, "今日头条"],
  [/sina\.com|weibo\.com/, "新浪"],
  [/163\.com/, "网易"],
  [/sohu\.com/, "搜狐"],
  [/qq\.com/, "腾讯网"],
  [/thepaper\.cn/, "澎湃新闻"],
  [/cls\.cn/, "财联社"],
  [/wallstreetcn\.com/, "华尔街见闻"],
  [/caixin\.com/, "财新"],
  [/gelonghui\.com/, "格隆汇"],
];

function sourceOf(url: string): string {
  for (const [re, name] of SOURCE_NAMES) {
    if (re.test(url)) return name;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 权威来源判定：主流新闻门户 + 官媒 + 通讯社。用于给报道取材时优先采信、交叉核对。
const AUTH_DOMAINS =
  /thepaper\.cn|sina\.com|news\.163\.com|163\.com|qq\.com|sohu\.com|toutiao\.com|baijiahao\.baidu\.com|people\.com\.cn|xinhuanet\.com|news\.cn|cctv\.com|cnr\.cn|chinanews\.com|chinadaily\.com|gmw\.cn|ce\.cn|cyol\.com|jfdaily\.com|bjnews\.com|nbd\.com|yicai\.com|caixin\.com|ifeng\.com|huanqiu\.com|stcn\.com|cls\.cn|wallstreetcn\.com|gelonghui\.com/i;
function isAuthoritative(url: string): boolean {
  return AUTH_DOMAINS.test(url);
}

// 把「热搜平台名」映射到 sourceOf() 会产出的来源标签，用于判断文章/视频是否同平台。
// 例：热搜来自知乎 → 认可 source 为「知乎」的文章；B站 → 「哔哩哔哩」的视频。
// 返回空数组表示该平台没有可直接抓取的对应站点（如小红书），此时走跨平台兜底。
function platformMatchSources(platform: string): string[] {
  const p = platform.toLowerCase();
  if (/知乎|zhihu/.test(p)) return ["知乎"];
  if (/b站|bili|哔哩/.test(p)) return ["哔哩哔哩"];
  if (/抖音|douyin/.test(p)) return ["抖音"];
  if (/微博|weibo/.test(p)) return ["新浪"];
  if (/头条|toutiao/.test(p)) return ["今日头条", "西瓜视频"];
  if (/百度|baidu/.test(p)) return ["百家号"];
  if (/腾讯|qq|v\.qq/.test(p)) return ["腾讯网", "腾讯视频"];
  if (/网易|163/.test(p)) return ["网易"];
  if (/澎湃|thepaper/.test(p)) return ["澎湃新闻"];
  // 小红书、什么值得买等无公开可抓站点 → 空，交给跨平台兜底
  return [];
}

// 自建 SearXNG 接口（部署在腾讯云 VPS，中国区 IP）。
// 检索实现已抽到 @/lib/searx 共享模块（12s 超时 + 空结果换词重试 + 10min 缓存）。
// 本路由只保留签名适配：百科/垃圾站过滤由下方 isGenericRef/relevance 在业务层做，
// 所以这里不开共享模块的 dropWiki，safesearch 沿用 0（视频/报道源不过度过滤）。

// 调用 SearXNG 的 JSON 接口，返回结构化的标题/链接/摘要
async function searxSearch(
  query: string,
  category: "general" | "videos",
  limit: number
): Promise<SearchHit[]> {
  const hits = await searxSearchLib(query, { category, limit, safesearch: 0 });
  return hits.map((h) => ({
    title: h.title,
    url: h.url,
    content: h.content,
    ...(h.published ? { published: h.published } : {}),
  }));
}

const isVideoUrl = (u: string) =>
  /bilibili\.com\/video|b23\.tv|youtube\.com\/watch|youtu\.be|douyin\.com|v\.qq\.com|ixigua\.com/.test(
    u
  );

// 轻量纠错层（零 token 成本）：游戏/电竞/科技领域常见缩写错拼的静态映射。
// 用户快速打字时容易打错字母顺序（cggo→csgo→CS2）或漏字母，纯字符串替换。
// 只做确定性映射，不做通用 NLP 纠错——避免误报、零成本。
const TYPO_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\bcggo\b/gi, "CS2"],
  [/\bcsgo\b/gi, "CS2"],
  [/\bdota2?\b/gi, "Dota2"],
  [/\bwd4\b/gi, "原神"],
  [/\blol\b/gi, "LOL"],
  [/\bvalorant\b/gi, "无畏契约"],
  [/\bpubg\b/gi, "绝地求生"],
];
const applyTypoFix = (t: string): string => {
  let out = t;
  for (const [re, fix] of TYPO_MAP) out = out.replace(re, fix);
  return out;
};

// 去掉书名号/引号/括号/星号/标点等会干扰搜索分词的符号，得到核心词
const cleanTopic = (t: string) =>
  applyTypoFix(t)
    .replace(/[《》「」【】〈〉“”"'`（）()\[\]｜|、，,。.！!？?~—\-*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// 相关性打分：文本（标题+摘要）与话题的 2-gram 重合数（完整命中额外加权）
function relevanceScore(text: string, topic: string): number {
  const t = text.replace(/\s+/g, "");
  const kw = topic.replace(/\s+/g, "");
  if (kw.length < 2) return t.includes(kw) ? 1 : 0;
  let score = 0;
  const seen = new Set<string>();
  for (let i = 0; i + 2 <= kw.length; i++) {
    const g = kw.slice(i, i + 2);
    if (seen.has(g)) continue;
    seen.add(g);
    if (t.includes(g)) score += 1;
  }
  if (t.includes(kw)) score += 2; // 完整包含话题，强相关
  return score;
}

// 事实门专用：通用中文功能词表（NLP 停用词，与任何具体领域无关）。
// 用途：无明确主体的裸话题算"强相关证据"时，必须先剥掉这些词——"你引用了哪些来源网站"
// 剥完没有任何鉴别性实词，百科里的"引用来源"字样就不能再伪装成强证据；
// 而"阴阳怪气男团兴衰史""海南女主播诈骗案"这类真话题，专有名词不受影响、照样高分。
// 只用于从严降权，绝不参与放行，所以表再宽也不会误伤正常话题。
const FACT_STOP_CHARS = new Set(
  (
    "你我他她它们的了着过是在有和也就都还要会能可以吗呢吧啊呀嘛呗哦哈 这个那个这些那些什么怎么怎样为什么哪里哪个哪些多少谁 后来现在以前以后最近最新今天昨天明日近期 事情东西问题情况时候方面地方 引用来源网站网页资料文章内容链接地址 一下一些没有不是一个一下 请帮我给把被让向往从对为到与及或而且但如果因为所以然后接着再来换改写 呢么啥么咋"
  )
    .replace(/\s/g, "")
    .split("")
);
// 剥功能词后保留有鉴别力的实词片段（≥2 字）；片段全是功能词（"那个事""来源网站"）→ 返回 []
function factContentParts(q: string): string[] {
  return q
    .split(/[\s，,。.！!？?；;：:、「」【】《》""''（）()\[\]…—~·]+/)
    .flatMap((seg) => {
      let buf = "";
      const parts: string[] = [];
      for (const ch of seg) {
        if (FACT_STOP_CHARS.has(ch)) {
          if (buf.length >= 2) parts.push(buf);
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.length >= 2) parts.push(buf);
      return parts;
    });
}

// 归一（去空白+小写）：主体名/角度词匹配统一口径
const normRefText = (s: string) => s.replace(/\s+/g, "").toLowerCase();
// 角度词整句命中：全文包含某条角度查询的完整词组（≥4字）——
// "把女友保护得很好"整句出现在帖子里，比"保护/女友"2-gram 散命中可信得多
const strongAngleHit = (txtNorm: string, qs: string[]) =>
  qs.some((q) => {
    const n = normRefText(q);
    return n.length >= 4 && txtNorm.includes(n);
  });

// 百科/词典/搜索引擎自身页面——这类不是"事件报道"，一律剔除。
// 注意（2026-09）：百家号文章页（baijiahao.baidu.com/s?id=…）是确切帖子不是搜索页——
// 路径恰好含 "baidu.com/s?"，必须先排除，否则搜索引擎跳转链展开出来的百家号原文会被误杀。
// 2026-09 第二轮补漏（均为泛化规则，不针对任何具体品牌/个例）：
// · image.baidu.com / baidu.com/search/index：百度图片搜索结果页（不是报道），
//   旧规则只拦 baidu.com/s?，图片搜索路径漏网，还会被 sourceOf 误标成"百家号"；
// · 电商店铺/商品页（任意 xxx.tmall.com 店铺、taobao 商品/搜索、京东商品、拼多多商品）：
//   角度词撞上同名品牌时（"361度"既是梗也是运动品牌），天猫店/商品页会混进召回——
//   这类页面不含任何对主体的讨论，一律剔除；
// · passport.weibo.com/visitor：微博访客跳转墙（真实帖子链在其 url 参数里，
//   先经下方跳转链展开还原；展开失败仍落到这里时按垃圾页过滤）。
const isGenericRef = (u: string) => {
  if (/^https?:\/\/[^/]*baijiahao\.baidu\.com\//.test(u)) return false;
  // 微博访客跳转墙：host 有两种形态——passport.weibo.com/visitor 与
  // visitor.passport.weibo.cn/visitor/visitor?…（2026-09 第三轮补），统一按
  // "host 含 passport.weibo 且路径含 /visitor" 识别。
  if (u.includes("passport.weibo") && u.includes("/visitor")) return true;
  return /baike\.baidu\.com|wikipedia\.org|wiki[a-z]*\.|\.wiki|hanyu\.baidu|dict\.|cidian|zhidao\.baidu|zhihu\.com\/topic|so\.com\/link|baidu\.com\/s\?|bing\.com\/search|google\.[a-z.]+\/search|image\.baidu\.com|baidu\.com\/search\/index|\.tmall\.com\/|tmall\.com\/shop\/|item\.taobao\.com|s\.taobao\.com\/(search|list)|taobao\.com\/list|item\.jd\.com|yangkeduo\.com\/goods/.test(
    u
  );
};

// 角度查询组（2026-09）：把主体名从查询里剥掉，只留纯角度词。
// 为什么必须剥：2-gram 打分下罗马字主体名（zont1x → zo/on/nt/t1/1x 共 5 gram）会碾压
// 中文角度词（男模/颜值 → 1-2 gram），任何提到主体的生涯页/百科页都比"讨论他长相的帖"
// 分高，角度内容永远上不了前排——用户看到的"男模"条目详情全是生涯资料就是这个病。
// 主体名相关性不再靠 gram 体现，改由排序时的 anchor 加分表达。
function aspectQueries(queries: string[], anchor: string): string[] {
  const a = (anchor || "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  let strip = (q: string) => q.trim();
  if (a) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    strip = (q: string) =>
      q.replace(new RegExp(esc, "gi"), " ").replace(/\s+/g, " ").trim();
  }
  for (const q of queries) {
    const s = strip(q);
    if (s.length < 2) continue; // 剥完只剩单字（角度词太短）→ 无鉴别力，跳过
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// 条目标题检索词截短（2026-09 泛化）：热榜/方向区条目标题常是
// "概括语，梗句，概括语"的复合长句。中文没有空格，split(" ") 切不开，
// slice(0,20) 截出来的仍是半截长句——整段拿去搜，"360°无死角的帅被截出361°"
// 这类小众词条基本空手而归，召回池里只剩主体生涯页和蹭词帖。改为按标点切成
// 短句后挑"最有检索价值"的一段：含数字的优先（"360°""361°"这类具体数字是
// 梗句指纹），其次取最长句；引号里的角度名仍最优先（调用方处理）。26 字符兜底。
function pickSearchSlice(t: string): string {
  const raw = (t || "").trim();
  const parts = raw
    .split(/[，；。！？、;!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  if (!parts.length) return raw.slice(0, 26);
  let best = parts[0];
  let bestSc = -1;
  for (const p of parts) {
    let sc = p.length;
    if (/\d/.test(p)) sc += 12; // 具体数字 = 梗句指纹（"361°" "天花板"带数据的事实句同理）
    if (sc > bestSc) {
      bestSc = sc;
      best = p;
    }
  }
  return best.slice(0, 26);
}

// 角度关键词提取（2026-09 主体条目召回补丁·v2）：主体条目的检索词 = 主体 + 1-2 个短关键词。
// 关键约束：bing 中文搜索对多关键词做 AND 匹配——3 个以上关键词几乎搜不到东西，
// 只剩百科/配置页这类通用主体资料。所以只取 1-2 个最有鉴别力的词：
// ① 数字短语：取"数字+量词"（"361度"而非"360度无死角的"），是梗句指纹；
// ② 描述词：取 1 个最具体的（预定义数组按鉴别力排序，"颜值""出圈"优先于"帅"）。
const ANGLE_KEY_WORDS = [
  "颜值", "丑照", "出圈", "反差", "争议", "翻车",
  "回归", "夺冠", "下放", "退役", "转会",
  "获奖", "提名", "战绩", "登顶",
];
function extractAngleKeywords(topic: string, entity: string): string[] {
  const stripEntity = entity
    ? topic.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    : topic;
  const cleaned = cleanTopic(stripEntity).replace(/\s+/g, " ").trim();
  const out: string[] = [];
  const seen = new Set<string>();

  // ① 数字短语：只取"数字+量词"（"361度"），最多 1 个。
  // 取所有命中中**最后出现**的——梗句里反转点通常在后面（"360°无死角"是形容，
  // "被截出361°"才是笑点），取最后一个更有鉴别力。
  const numAll = cleaned.match(/\d{1,4}[°度%周岁年冠强票金球分]/g) || [];
  if (numAll.length) {
    const last = numAll[numAll.length - 1];
    out.push(last);
    seen.add(last);
  }

  // ② 描述词：按预定义顺序取第一个命中的，最多 1 个
  if (out.length < 2) {
    for (const w of ANGLE_KEY_WORDS) {
      if (cleaned.includes(w) && !seen.has(w)) {
        out.push(w);
        break;
      }
    }
  }

  // ③ fallback：pickSearchSlice 截短到 ≤8 字
  if (out.length === 0) {
    const slice = pickSearchSlice(cleaned).slice(0, 8);
    if (slice.length >= 2) out.push(slice);
  }

  return out;
}

// 主体名兜底提取（2026-09 泛化；第三轮加话题内候选优先）：详情入口不一定带 entity——
// 从聊天/热榜进来的条目只有"主体结构回复"才带主体名。缺它时整段标题当检索词、蹭词帖
// 滤不掉、讨论主体的帖子进不了列表，三个病一根因。
// 候选来源（按可信度排序）：
// ①【话题里的说话人】"罗翔说的法外狂徒张三"——紧跟"说的/称/表示/老师"等的 2-4 字
//   中文片段就是主体本人，且该片段在召回里出现≥1次即采纳（泛化规则，不针对具体人名）；
// ②【话题里反复出现的中文名】话题原文的 2-3 字中文片段在召回中出现≥3次——不在话题里的
//   中文词无分词依据，不可靠，不取；
// ③【高频拉丁词】原逻辑（≥4次、排除通用/平台词）。但话题本身是中文（含≥2个汉字）时，
//   拉丁候选【必须也出现在话题原文里】才采纳——否则"罗翔说的法外狂徒张三是什么梗"会被
//   召回里高频的 roblox 带跑（实测：整页变成 Roblox 游戏内容）。
const GUESS_STOP = new Set([
  "www", "http", "https", "com", "cn", "net", "html", "htm",
  "the", "and", "for", "with", "video", "watch", "full", "episode",
  "team", "club", "pro", "prosettings", "config", "settings", "rating",
  "cs", "cs2", "csgo", "hltv", "blast", "mvp", "lol", "lpl", "lck",
  "weibo", "zhihu", "tieba", "douyin", "bilibili", "xiaohongshu",
  "baidu", "sina", "qq", "sohu", "nga",
]);
// 中文片段停用 2-gram：话题里的连接词/疑问词/万能词，即使在召回里高频也不是主体名
const GUESS_CN_STOP = new Set([
  "什么", "怎么", "为什么", "到底", "可以", "觉得", "知道", "一个", "这个",
  "那个", "没有", "不是", "就是", "还是", "或者", "如果", "因为", "所以",
  "已经", "现在", "最近", "视频", "热点", "事件", "话题", "内容", "说的",
  "的说", "真的", "直接", "到底", "是什么", "什么梗", "的梗", "吗", "呢",
  // 角色/群体词："网友说的""博主称""官方表示"里它们是主语但不是主体本人
  "网友", "粉丝", "博主", "作者", "媒体", "官方", "评论", "大家", "有人",
  "他们", "我们", "自己", "观众", "路人", "主播", "记者", "专家", "团队",
]);
function guessEntity(topic: string, hits: SearchHit[]): string {
  const hay = hits.map((h) => `${h.title} ${h.content}`).join("\n");
  const countInHay = (s: string) => {
    if (!s) return 0;
    let n = 0;
    let idx = hay.indexOf(s);
    while (idx !== -1) {
      n++;
      idx = hay.indexOf(s, idx + s.length);
    }
    return n;
  };
  type Cand = { name: string; sc: number };
  const cands: Cand[] = [];

  // ① 话题里的说话人：X说的/说过/称/表示/讲/谈/聊/老师/教授/律师/医生
  const speakerRe =
    /([\u4e00-\u9fa5]{2,4})(说的|说过|表示|称|讲|谈|聊|老师|教授|律师|医生)/g;
  let sm: RegExpExecArray | null;
  while ((sm = speakerRe.exec(topic)) !== null) {
    const name = sm[1];
    if (GUESS_CN_STOP.has(name)) continue;
    const f = countInHay(name);
    if (f >= 1) cands.push({ name, sc: 10000 + f });
  }

  // ② 话题原文的 2-3 字中文片段（滑窗），召回中出现≥3次
  const runs = topic.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of runs) {
    for (let len = 3; len >= 2; len--) {
      for (let i = 0; i + len <= run.length; i++) {
        const gram = run.slice(i, i + len);
        if (GUESS_CN_STOP.has(gram)) continue;
        if (/[的了吗呢啊吧吗呢嘛哦]/.test(gram)) continue;
        const f = countInHay(gram);
        if (f >= 3) cands.push({ name: gram, sc: 1000 + f * 10 + len });
      }
    }
  }

  // ③ 高频拉丁词
  const topicLower = topic.toLowerCase();
  const topicIsChinese = (topic.match(/[\u4e00-\u9fa5]/g) || []).length >= 2;
  const freq = new Map<string, number>();
  for (const h of hits) {
    const words =
      `${h.title} ${h.content}`.match(/[A-Za-z][A-Za-z0-9_-]{2,15}/g) || [];
    for (const w0 of words) {
      const w = w0.toLowerCase();
      if (GUESS_STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  for (const [w, f] of freq) {
    if (f < 4) continue;
    const inTopic = topicLower.includes(w);
    if (topicIsChinese && !inTopic) continue; // 中文话题不接受话题外的拉丁主体
    cands.push({ name: w, sc: (inTopic ? 2000 : 0) + f });
  }

  cands.sort((a, b) => b.sc - a.sc);
  return cands[0]?.name || "";
}

// 汇总去重 + 剔除百科/搜索页 + 按（标题+摘要）相关性排序，丢弃零重合，取前 limit 条。
// anchor（主体名）非空时做【强相关分层】（2026-09 收紧）：前排只留"提到主体名"或
// "角度词整句命中"的条目——角度词 2-gram 裸命中（如"怎么保护女友的安全"蹭"保护女友"
// 四字、"XX公开恋情"蹭"恋情"）不再混进前排，用户按参考列表核对观点出处时点开的
// 全是不相关帖就是这么来的。分层不丢量：弱相关垫底补足列表。
// 新鲜度（2026-09）：近30天 +2 / 近半年 +0.75 的加权，平分时新帖排前——
// 强时效结果不再被旧帖压在参考列表尾部。
// queries（2026-09 扩展）：查询扩展产出的侧面查询组。
function rankLoose(
  lists: SearchHit[][],
  topic: string,
  limit: number,
  anchor = "",
  queries: string[] = [],
  looseVideo = false
): Link[] {
  const a = normRefText(anchor || "");
  const angleQs = aspectQueries([topic, ...queries], anchor.trim());
  const qs = angleQs.length ? angleQs : [topic];
  const now = Date.now();
  const freshBonus = (ts?: string) => {
    if (!ts) return 0;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return 0;
    if (t >= now - 30 * 864e5) return 2;
    if (t >= now - 180 * 864e5) return 0.75;
    return 0;
  };
  const seen = new Set<string>();
  const merged: {
    l: Link;
    s: number;
    d: number;
    i: number;
    t1: boolean;
    ang: boolean;
    anc: boolean;
    cjk: number;
  }[] = [];
  let idx = 0;
  for (const list of lists) {
    for (const h of list) {
      if (seen.has(h.url) || isGenericRef(h.url)) continue;
      seen.add(h.url);
      const txt = normRefText(`${h.title} ${h.content}`);
      const hitAnchor = !!a && txt.includes(a);
      // 角度纯相关分（不含主体名加分）：视频 UGC 标题判定用——
      // 剥掉 anchor 后仍与角度词有足够 2-gram 重合，说明这条确实在讨论该角度。
      const angleScore = Math.max(
        ...qs.map((q) => relevanceScore(txt, normRefText(q)))
      );
      // 中文描述词命中分：只数【含汉字】的角度 2-gram 重合。数字短语（"361度"）既是梗指纹
      // 也可能是同名品牌（361°运动鞋）——纯靠数字 gram 放行会放进"361度跑鞋开箱"这类电商噪声。
      // 要求视频至少沾到一个汉字角度词（颜值/帅/丑/颜剪…），才算真在讨论这个梗。
      const cjkAngleScore = qs.reduce((best, q) => {
        const kws = normRefText(q);
        let sc = 0;
        const seenGram = new Set<string>();
        for (let i = 0; i + 2 <= kws.length; i++) {
          const g = kws.slice(i, i + 2);
          if (seenGram.has(g) || !/[\u4e00-\u9fa5]/.test(g)) continue;
          seenGram.add(g);
          if (txt.includes(g)) sc += 1;
        }
        return Math.max(best, sc);
      }, 0);
      const s = angleScore + (hitAnchor ? 0.5 : 0);
      const ang = strongAngleHit(txt, qs);
      // t1（进前排资格）：
      // · 文章路（looseVideo=false）：有主体名时必须【提到主体名】才进前排——
      //   防"长得帅有多大优势"这类不提主体、只靠通用词沾边的蹭词帖。
      // · 视频路（looseVideo=true）：B 站 UGC 标题习惯用昵称/称号/梗（"宗宗""宗主"
      //   "360°的帅被截361°"）而不写本名，角度词却往往直接命中（"颜剪""颜值纯享"）。
      //   只认本名会把最相关的玩梗/颜值剪辑全滤光。放宽为：提到主体名；或角度词整句命中
      //   (ang)；或【汉字角度词】命中≥2（cjkAngleScore，排除纯靠"361度"数字品牌词混入的
      //   电商/开箱噪声）。仅作用于视频，文章路仍严格，蹭词帖口子不重开。
      const t1 = !a
        ? true
        : looseVideo
          ? hitAnchor || ang || cjkAngleScore >= 2
          : hitAnchor;
      merged.push({
        l: {
          title: h.title,
          url: h.url,
          source: sourceOf(h.url),
          ...(h.published ? { date: h.published } : {}),
          ...(h.content ? { snippet: h.content.slice(0, 150) } : {}),
        },
        s: s + freshBonus(h.published),
        d: h.published ? Date.parse(h.published) || 0 : 0,
        i: idx++,
        t1,
        ang,
        anc: hitAnchor,
        cjk: cjkAngleScore,
      });
    }
  }
  const positive = merged
    .filter((x) => x.s > 0) // 零分 = 既不沾角度也不沾主体（跑偏/无关结果），直接丢弃
    .sort(
      (x, y) =>
        Number(y.t1) - Number(x.t1) ||
        // 视频路：提到主体名的最可靠（昵称梗视频靠 cjk/ang 放行但排序让位于真名视频），
        // 避免"361度跑鞋开箱"这类不含主体、仅靠角度散命中的电商噪声压过真主体视频。
        Number(y.anc) - Number(x.anc) ||
        Number(y.ang) - Number(x.ang) ||
        y.cjk - x.cjk ||
        y.s - x.s ||
        y.d - x.d ||
        x.i - y.i
    );
  // 强相关直通；弱相关（没提主体名、角度词也只是 2-gram 散命中）在【有主体名】场景下
  // 大概率是蹭词噪声（"怎么保护女友的安全"蹭"保护女友"）——用户点开参考列表核对观点
  // 出处，点到的全是不相关帖就是它们混进前排/垫底造成的。有主体名时弱相关直接不进列表
  // （宁短勿滥）；主体一个都没命中时回退放开全量，避免空列表触发兜底搜索页。
  // 2026-09 评测补漏：回退路径【也不放行纯噪声】——强相关为空时此前直接回退 positive
  // 全量，仅靠偶然 2-gram（如"网约车提车"撞上泛角度词）的无关帖就这样混进垫底。
  // 回退时仍要求至少一项可信信号：提到主体名 / 角度整句命中 / 汉字角度词命中≥2。
  const credible = (x: (typeof merged)[number]) =>
    !a || x.t1 || x.ang || x.cjk >= 2;
  const strong = a ? positive.filter((x) => x.t1) : positive;
  const pool = strong.length ? strong : positive.filter(credible);
  return (pool.length ? pool : positive)
    .slice(0, limit)
    .map((x) => x.l);
}

// 查询扩展（2026-09 泛化补丁 / 第二轮升级）：主体+窄角度条目（如"zont1x 男模"）的检索词
// 被角度词钉死，只会召回与角度词字面匹配的内容——讨论颜值的帖、喷实力的帖、说近期状态
// 的帖根本进不了召回池。这里让 LLM 把话题语义拆解成多个不同侧面的查询（人物：身份/实力/
// 近况/形象/舆论争议；事件：起因/回应/进展；产品：口碑/对比/动态——按话题类型自适应，
// 不写死领域词），并集检索补召回。
// 第二轮改动：① 返回结构化 {queries, keywords}——keywords 是网友讨论该角度时的大白话
// 短词（颜值/帅/长相…），用于平台内（微博/贴吧/知乎）短词检索，这些平台的搜索对长查询
// 几乎零召回；② 超时 8s→20s——DeepSeek JSON 生成偶发 10s+，8s 会静默超时退回三个
// 硬编码通用词，语义拆解等于没做；③ 同名概念护栏——角度词撞上同名品牌/产品（如数字梗
// "361度"也是运动品牌）时，严禁扩展成该同名概念本身，所有查询必须围绕讨论主体。
// 失败/超时返回空结构，调用方退「主体+通用侧面词」兜底。
type ExpandResult = { queries: string[]; keywords: string[] };
async function expandQueries(
  topic: string,
  core: string,
  entity: string,
  opts: { angleLike?: boolean } = {}
): Promise<ExpandResult> {
  const empty: ExpandResult = { queries: [], keywords: [] };
  // 扩展同样基于剥壳短语。prompt 只给内容中立的语法规则，不写任何具体实体/案例。
  const plan = queryPlan(topic);
  const ctxHint = plan.context.length
    ? `核心短语中的每个限定成分都必须原样保留在每条 query 里：${plan.main}`
    : "";
  // 角度句模式（2026-09）：topic 是「内容选题角度」描述（"XX向：X月X日某平台称
  // 「圈内黑话」，可做一期…"），不是搜索词。必须提取其中真正可检索的对象，
  // 黑话/外号/蔑称按网友原词原样保留——2-3 字短词是它们在平台站内的唯一索引形态。
  const angleRule = opts.angleLike
    ? `
0. 这句话是一条内容选题角度的【描述】，不是搜索词：里面有日期、平台导语（某平台/某帖/高赞）、编辑元话语（"向：""可做""一期"），这些全部不能进 query；
0a. 提取角度里真正要去检索的对象：人物/作品/事件名、圈内黑话、外号、蔑称、金句原句——圈内用词必须用网友原词原样输出，哪怕只有 2-3 个字，不要翻译成书面语，也不要加修饰词把它变长；
0b. 把长句拆成 2-5 个互相独立的短原子短语（每个只搜一个对象），不要把日期、平台名和黑话拼在同一条里；`
    : "";
  try {
    const llm = getLlm();
    const res = await fetchWithTimeout(
      `${llm.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: `扩展搜索词。话题：「${topic}」${
                entity ? `（主体：${entity}）` : ""
              }，检索核心短语：「${plan.main}」${
                ctxHint ? `。${ctxHint}` : ""
              }。
规则：${angleRule}
1. 每条 query 必须是短语不是问句——剥掉疑问外壳（什么是/是什么/为什么/怎么看待 等）；
2. 核心短语必须整体保留，严禁只抽其中一个泛词去搜；用户写下的每个限定成分都不能丢；
3. 按话题本身涉及的不同侧面拆分（起因/进展/回应/影响、本义/出处/同类说法、身份/近况/争议 等中选取真实适用的，不适用的不要硬凑）。
输出 JSON：{"queries":["q1","q2","q3","q4","q5"],"keywords":["k1","k2","k3"]}
queries：5个搜索短语，每个≤14字${
                entity ? `，以${entity}开头` : "，紧扣核心短语"
              }。keywords：2-4个${
                opts.angleLike
                  ? "角度里的圈内原词（黑话/外号/蔑称/作品名，2-6字，原样保留不要翻译）"
                  : "网友讨论该话题时的大白话短词（2-6字，可含英文/数字）"
              }。只返回JSON。`,
            },
          ],
        }),
      },
      20000
    );
    const json = await res.json();
    const txt: string = json.choices?.[0]?.message?.content || "";
    const m = txt.match(/[\[{][\s\S]*[\]}]/);
    if (!m) return empty;
    let rawQs: unknown[] = [];
    let rawKws: unknown[] = [];
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) {
        rawQs = parsed;
      } else if (parsed && typeof parsed === "object") {
        rawQs = Array.isArray((parsed as any).queries) ? (parsed as any).queries : [];
        rawKws = Array.isArray((parsed as any).keywords) ? (parsed as any).keywords : [];
      }
    } catch {
      return empty;
    }
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const coreNorm = norm(core);
    const queries: string[] = [];
    const seenQ = new Set<string>();
    for (const x of rawQs) {
      if (typeof x !== "string") continue;
      const q = x.replace(/[《》「」【】"'“”]/g, "").trim().slice(0, 20);
      if (q.length < 3) continue;
      const k = norm(q);
      if (k === coreNorm || seenQ.has(k)) continue;
      seenQ.add(k);
      queries.push(q);
      if (queries.length >= 5) break;
    }
    const keywords: string[] = [];
    const seenK = new Set<string>();
    for (const x of rawKws) {
      if (typeof x !== "string") continue;
      const kw = x
        .replace(/[《》「」【】"'“”，。！？、：:；;！!?.,~—-]/g, "")
        .replace(/\s+/g, "")
        .trim()
        .slice(0, 6);
      // 短词鉴别力门槛：含汉字，或含≥2位英文字母（cs/nba 这类圈子词也是有效短词）；
      // 纯数字短词平台搜索噪声大，排除（它该出现在 queries 短语里，而不是单搜）。
      if (kw.length < 2) continue;
      if (!/[一-鿿]/.test(kw) && !/[a-z]{2,}/i.test(kw)) continue;
      const k = norm(kw);
      if (seenK.has(k)) continue;
      seenK.add(k);
      keywords.push(kw);
      if (keywords.length >= 4) break;
    }
    return { queries, keywords };
  } catch {
    return empty;
  }
}

// 出生日期探测（2026-09 第二轮，与 script 路由 probeBirthBlock 同构）：
// detail 的报道/简介此前没有年龄守卫——旧报道标题里的"今年17，天下第一"（2024 年文章）
// 会被模型当成现状写进报道与简介（实测 donk 2007 年生、2026 年已 19 岁，报道仍写"17岁"）。
// 与报道生成【并行】探「主体名+出生/born」两路（中文社区 + 英文资料页，生日最大来源是
// Liquipedia/Wikipedia 的 "(born July 20, 2005)"），只收含出生信息的片段给 fixAgeClaims
// 当真相源。失败/超时返回空串，守卫无真相不改写，不影响主流程。
async function probeBirthBlock(entity: string): Promise<string> {
  if (!entity) return "";
  try {
    const [zh, en] = await Promise.all([
      searxSearchUnion(`${entity} 出生`, { limit: 8, safesearch: 0 }).catch(
        () => [] as SearchHit[]
      ),
      searxSearchUnion(`${entity} born`, { limit: 8, safesearch: 0 }).catch(
        () => [] as SearchHit[]
      ),
    ]);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const h of [...zh, ...en]) {
      const t = `${h?.title || ""} ${h?.content || ""}`
        .replace(/\s+/g, " ")
        .trim();
      const u = String(h?.url || "");
      if (!t || !/出生|生于|出世|born\s|birthday/i.test(t)) continue;
      if (u && seen.has(u)) continue;
      if (u) seen.add(u);
      lines.push(t.slice(0, 160));
      if (lines.length >= 4) break;
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// （2026-09 根治）前置 LLM「话题有没有对象」澄清门已删除。
// 旧架构让模型在【检索之前】猜措辞值不值得搜——措辞有无穷变体（男团角度句、英文、缩写、
// 方言、创作提案式写法……），每误伤一类就要补一条 prompt 例子，永远补不完，且 detail 的
// 调用契约是应用内「查看详情」（自由问答走 /api/chat），前置猜意图本身就是架构错配。
// 现行口径只有一条，与领域/措辞/语言无关：先检索，再看【有没有召回与话题强相关的事实】——
// 事实充分则出报告，零强相关命中则确定性返回「暂无直接相关资料」（见 POST 内事实门）。

export async function POST(req: NextRequest) {
  try {
    const {
      topic,
      platform,
      url,
      entity: rawEntity,
      keywords: rawKeywords,
      llm: rawLlm,
      _evalGround,
    } = await req.json();
    // 绑定本请求的 LLM 配置（强制 BYOK：访客自带 Key；仅内部调用可用系统 Key），
    // expandQueries / genProfile / genReport / genMaterial 内通过 getLlm() 读取。
    setRequestLlm(resolveRequestLlm(rawLlm, isInternalRequest(req)));
    // 没配 Key（用户没填自带 Key、服务端 env 也没配）：报道/素材卡都无法生成，
    // 直接返回 no_key 引导，让前端弹「配置 API Key」按钮，而不是给一个只有链接的空面板。
    if (!getLlm().apiKey) {
      throw new LlmApiError("no_key", "未配置 API Key");
    }
    if (!topic || typeof topic !== "string") {
      return NextResponse.json({ report: "缺少话题信息。", sites: [], videos: [] });
    }
    // entity：主体结构的方向区条目会带上所属主体名（如 zont1x、Cursor、村超）。
    // 有它时检索与成文都以"主体本身"为核心（主体+角度词），避免拿整句条目泛泛搜索。
    // 可被兜底提取改写（2026-09 泛化）：从聊天/热榜直接进详情的条目不一定带主体名，
    // 首轮只能拿整段标题检索"发现"主体，随后从召回里提取高频主体名改写 entity/core，
    // 让角度检索、打分分层、报道成文全部对准主体（见下方 guessEntity 调用处）。
    // 入防线（2026-09 实锤事故）：前端旧版可能把模型叙事残段"已核实资料显示"当主体名
    // 传来，脏主体会污染 core/appSearchKW/全部 SearXNG 检索词（服务器日志实锤
    // q=已核实资料显示 腐女）。这里统一做内容中立的句式校验：是叙事句/无专名特征就清空，
    // 走无 entity 的 queryPlan 概念路径，宁空勿错。
    let entity =
      typeof rawEntity === "string" ? sanitizeEntityCandidate(rawEntity) : "";
    // 主体是否由调用方明确给出（区别于下方 guessEntity 从跑偏召回里"猜"出来的主体）。
    // 事实门只信任明确主体：猜出来的主体不能给检索结果自证（残句会把随机新闻人物猜成主体）。
    const entityFromCaller = entity.length > 0;
    // 这条热点自身的原文链接（从热榜一路透传下来）。若合法，则无条件作为「核心来源」：
    // 既置顶到参考网站/视频，也作为报道取材的第一篇，解决"主报道没出现在参考文献里"的问题。
    const originUrl =
      typeof url === "string" && /^https?:\/\//.test(url.trim())
        ? url.trim()
        : "";
    // 角度检索词（2026-09 显式检索契约）：前端从角度行尾的 〔搜：…〕 标记解析而来，
    // 是"这条角度想让用户去查的对象原词"（圈内黑话/外号/作品名），与展示用的长句解耦。
    // 旧消息没有标记时，再从 topic 的引号短语里做内容中立的启发式补词（2-3 字短黑话
    // 过去因 <5 字被前端取词整段跳过——这里后端再兜一道）。
    const callerKws = normalizeAngleKeywords(rawKeywords);
    const heuristicKws = !entity
      ? heuristicAngleKeywords(topic).filter((kw) => !callerKws.includes(kw))
      : [];
    const angleKws: string[] = [...callerKws, ...heuristicKws].slice(0, 5);
    // 这句话题是不是「角度/选题描述句」（"XX向：…，可做一期…"）。检索用文本剥掉
    // 角度标签壳，排序/成文仍用原句（长句里的描述词是 rankLoose 的精准锚点）。
    const angleLike = !entity && looksLikeAngleSentence(topic);
    const searchTopic = angleLike ? stripAngleLead(topic) : topic;
    // 角度原文（用于排序打分和报道/脚本生成，不用于搜索）——长句整段能帮助
    // rankLoose 精准识别讨论该角度的帖子，但扔给 SearXNG 搜不到。带显式检索词的
    // 角度句同理：检索走 angleKws，排序仍看整句。
    const angleText = entity || callerKws.length ? topic : "";
    // 所有查询统一先拆解：用户问句剥成检索短语（"cs中的研发芯片是什么梗"→"cs 研发芯片"），
    // 热榜短标题剥不出东西原样返回；有 entity 的主体条目仍走"主体+角度关键词"老路径。
    const plan = queryPlan(searchTopic);
    let core = cleanTopic(
      callerKws.length
        ? entity
          ? // 有主体 + 显式检索词：主体配第一个原词，其余词逐路 fan-out
            `${entity} ${callerKws[0]}`.replace(/\s+/g, " ").trim()
          : // 无主体：前两个原词 AND（两个圈内词并列在社区平台是强鉴别组合），
            // 每个词的裸搜路在下方 fan-out，防 AND 过严零召回
            callerKws.slice(0, 2).join(" ")
        : angleKws.length
          ? angleKws.slice(0, 2).join(" ")
          : entity
            ? // 主体条目：检索词 = 主体 + 2-3 个短关键词（数字短语优先、其次描述词）
              //   整段角度原文太长太窄，SearXNG 返回全是蹭词帖（详见 extractAngleKeywords）
              `${entity} ${extractAngleKeywords(topic, entity).join(" ")}`
                .replace(/\s+/g, " ")
                .trim()
            : plan.main
    );

    // 先做 SearXNG 检索，拿到真实资料后再据此生成报道（避免 LLM 凭空臆测）。
    // 新鲜度升级（2026-09）：改用四路并集（不限时+近30天+视频+新闻，新帖优先排序）——
    // 小众切入的窄查询词下，不限时相关度排序会被旧报道堆霸占（如"下放"旧闻盖过
    // "回归/夺冠"新进展），近窗新帖必须强制补入并置顶。并集全空（四路全挂）时
    // 退回原双路不限时调用兜底。
    // 主体现状路（2026-09新增）：entity 条目的检索词被角度词钉死（如"zont1x 舆论…"），
    // 四路并集再怎么扩时间窗，也只会召回与角度词匹配的内容——主体层面的最新进展
    // （回归首发/夺冠/转会）根本进不了召回池，时效规则写得再严也无米下锅。
    // 补一路「仅主体名」并集检索，把主体近况强行带入资料池（与角度路并行，按 URL 去重）。
    // expandQueries 分流（2026-09 v3）：
    // - 有 entity（热榜条目）：并行发起 expandQueries，与首轮四路搜索同时跑（已证实对
    //   主体条目几乎永远不触发原来的"召回<6"阈值——主体名路本身就带回一堆生涯页），
    //   所以改成必发但并行，不额外拖时间。
    // - 无 entity（chat 知识查询，如"CSGO if 梗的来源"）：**先等 expandQueries 完成**，
    //   拿到 5 个子查询后并行搜每个子查询——这是豆包搜得好的核心：不是整句搜，而是拆
    //   成多个精准子查询并行搜。整句"CSGO if 梗的来源"搜出来是泛泛的百科总结，但拆成
    //   "if梗 猎鹰 绿龙"、"if梗 科隆major"、"if梗 概念神"就能精准命中虎扑/NGA 讨论帖。
    //   这个路径的成本：1 次 LLM 扩展（~300 token 输出）+ 多几路 searx 搜索。
    let expandP: Promise<ExpandResult> | null;
    let chatAngleHits: SearchHit[] | null = null;
    if (entity || angleKws.length) {
      // 热榜路径 / 角度检索词路径：并行扩展（不阻塞首轮搜索）。
      // 角度句无主体时开 angleLike：让 LLM 把长句拆成黑话原词短查询，
      // 首轮先用 core（原词 AND）四路并集，不等它。
      expandP = expandQueries(topic, core, entity, {
        angleLike: !entity && angleLike,
      });
    } else {
      // chat 知识查询：先扩展，再用子查询搜——这是本次改动的核心价值
      const expand = await expandQueries(topic, core, entity, { angleLike });
      expandP = Promise.resolve(expand);
      if (expand.queries.length > 0) {
        // 并行搜每个子查询 + 原 core；另补两路内容中立的机械变体：
        // · extra：用户原句的分类名词拼回裸短语（"X是什么梗"→"X 梗"），召回方向词；
        // · bare：去掉限定成分的裸短语，给百科/通用来源留召回口。
        const allSubQs = [
          ...expand.queries,
          core,
          ...plan.extra,
          ...(plan.bare !== plan.main ? [plan.bare] : []),
        ];
        const subHitsArr = await Promise.all(
          allSubQs.map((q) =>
            searxSearchUnion(q, { limit: 20, safesearch: 0 }).catch(() => [])
          )
        );
        const seen = new Set<string>();
        const mergedSub: SearchHit[] = [];
        for (const arr of subHitsArr) {
          for (const h of arr) {
            if (seen.has(h.url)) continue;
            seen.add(h.url);
            mergedSub.push(h);
          }
        }
        chatAngleHits = mergedSub;
      }
    }
    const angleHitsPromise = chatAngleHits
      ? Promise.resolve(chatAngleHits)
      : searxSearchUnion(core, {
          limit: 36,
          safesearch: 0,
        }).catch(() => [] as SearchHit[]);
    const [angleHits, entityHits, crawlerHits, flashHits] = await Promise.all([
      angleHitsPromise,
      entity
        ? searxSearchUnion(entity, {
            limit: 18,
            safesearch: 0,
          }).catch(() => [] as SearchHit[])
        : Promise.resolve([] as SearchHit[]),
      // 平台内讨论路（2026-09）：吹颜值/喷实力/近况闲聊这类粉丝向内容只活在
      // 微博/贴吧/知乎里，通用搜索引擎几乎不索引——searx 并集再怎么扩也搜不到。
      // crawlerSearch 内部静默降级（挂了/超时/为空返回空数组），不拖主链路。
      crawlerSearch(core, { limit: 6 })
        .then(crawlerToHits)
        .catch(() => [] as SearchHit[]),
      // 快讯补充路（2026-09）：财联社/华尔街见闻/财新/格隆汇/澎湃的专业快讯是通用
      // 引擎索引慢、排序差的盲区，直连 RSS 拉全量（5min 缓存），与主检索并行零耗时；
      // 相关性在这里按检索词/主体过滤，防止财经流水整池灌水。
      flashNewsSearch(40)
        .then((hits) =>
          hits.filter((h) => {
            const text = `${h.title} ${h.content}`;
            return (
              relevanceScore(text, core) > 0 ||
              (entity ? relevanceScore(text, entity) > 0 : false)
            );
          })
        )
        .catch(() => [] as SearchHit[]),
    ]);
    let allHits: SearchHit[] = angleHits;
    if (entityHits.length) mergeHits(allHits, entityHits);
    if (crawlerHits.length) mergeHits(allHits, crawlerHits);
    if (flashHits.length) mergeHits(allHits, flashHits);
    if (allHits.length === 0) {
      const [g0, v0] = await Promise.all([
        searxSearch(core, "general", 30).catch(() => [] as SearchHit[]),
        searxSearch(core, "videos", 30).catch(() => [] as SearchHit[]),
      ]);
      allHits = [...g0, ...v0];
    }
    // 全新造词检测（2026-09 灰灰男案）：速览角度（无平台=从主体速览方向区点入，区别于
    // 热榜单条）的主体若是刚冒头的新外号/新梗，引擎对【主体裸词】没有真正的索引，上面强制
    // 「以主体开头」的扩展查询也全部零召回——角度句里真正有索引的实名锚点（事件当事人、
    // 关联实体）被这个没人写过的词一起陪葬，事实门只能回"没找到"。救援在下方扩展收口后。
    // 零索引判据不是"引擎返回0条"：生造词也会被模糊匹配到拆字字典/近名词条（实测"咘咘男"
    // 返回10条"咘"字字典和"咘咘"百科，没有一条含全名）；判据是【没有任何一条召回逐字包含
    // 完整主体名】——真正被讨论过的名字，召回里至少有页面原样写着它。
    const entityHitMentions = (h: SearchHit) =>
      `${h.title} ${h.content} ${h.url}`
        .toLowerCase()
        .includes(entity.toLowerCase());
    const entityBlind =
      !platform && entityFromCaller && !entityHits.some(entityHitMentions);
    // 救援取出的实名锚点短词（来自用户自己的角度句，非系统自造，可当事实门强证据词）
    let blindAnchorKws: string[] = [];
    // 主体名兜底提取（2026-09 泛化）：详情入口没带 entity 时（从聊天/热榜直接进来的
    // 条目只有"主体结构回复"才带主体名），长句查询歪打正着召回的帖子里反复出现真实主体名
    // ——提取它，改写 entity/core 并补「主体」+「主体×角度短句」两路检索：讨论该主体
    // 的帖子这才进得了召回池，rankLoose 也才有分层锚点把蹭词帖滤掉。此前"详情里明明
    // 在讲 zont1x，参考列表却全是'长得帅有多大优势'这类泛颜值蹭词帖"就是缺这步。
    // 概念提问禁用（2026-09）："cs中的研发芯片是什么梗"里"研发芯片"是一个概念短语、
    // 不是要被剥离的实体；从半导体跑偏召回里猜出"芯片"当主体，会让整条链路越跑越偏。
    // 定义/梗/意思/由来类查询一律围绕剥壳短语检索，不猜实体。
    if (!entity && !plan.isConceptAsk && !angleKws.length) {
      // 同样过句式守卫：被污染召回（如快照标题满是"已核实资料显示…"残句）里，
      // 高频词提取可能把叙事残段猜成主体名。
      const g = sanitizeEntityCandidate(guessEntity(topic, allHits));
      if (g) {
        entity = g;
        core = cleanTopic(
          `${g} ${pickSearchSlice(cleanTopic(topic))}`.replace(/\s+/g, " ").trim()
        );
        // 兜底提取到主体后，语义拆解同样必发（与下方补检索并行）
        expandP = expandQueries(topic, core, entity);
        const probeQ = core;
        const [gHits, gCrawl] = await Promise.all([
          searxSearchUnion(g, { limit: 18, safesearch: 0 }).catch(
            () => [] as SearchHit[]
          ),
          crawlerSearch(probeQ, { limit: 6 })
            .then(crawlerToHits)
            .catch(() => [] as SearchHit[]),
        ]);
        if (gHits.length) mergeHits(allHits, gHits);
        if (gCrawl.length) mergeHits(allHits, gCrawl);
      }
    }
    // 查询扩展（2026-09 第二轮重构）：
    // · 主体条目：语义拆解【必发】（expandP 在首轮检索时已并行发起，这里收口），
    //   角度侧面词（颜值/实力/近况/争议）稳定成为搜索词——治"梗概写了却从没搜过"；
    // · 无主体热榜条目：仍按"角度召回<6 才触发"省一次 LLM 调用。
    // LLM 失败退「主体+通用侧面词」兜底。
    let expandResult: ExpandResult | null = null;
    if (entity && expandP) {
      expandResult = await expandP;
    } else if (!entity && expandP) {
      // 无 entity（概念问句）：开头那次扩展是必发的，这里直接收口复用，
      // 不再按召回计数重发一次 LLM（旧逻辑会在同一条请求里连调两次）。
      expandResult = await expandP;
    }
    let expandQs: string[] = expandResult?.queries || [];
    // 角度句模式的确定性纠偏：LLM 偶尔无视"去掉模板壳"指令，扩展查询仍以
    // "XX向：…""…可做一期…"形态出现——这种查询送进引擎只回零相关垃圾、
    // 还会稀释 rankLoose 的锚点。内容中立地整路丢弃（原词裸搜 fan-out 不受影响）。
    if (!entity && angleLike && expandQs.length) {
      expandQs = expandQs.filter(
        (q) => !/(?:向|方向)\s*[：:]|可做|这期|本期|选题角度|切入(?:口|角度)?/.test(q)
      );
    }
    if (entity && expandQs.length === 0) {
      expandQs = [`${entity} 近况`, `${entity} 评价`, `${entity} 争议`];
    }
    // 全新造词救援（接上：entityBlind）：以【角度句模式、不带主体】重做一次语义拆解——
    // prompt 会从用户自己这句话里提取真正可检索的人物/事件名与原子短语（如"孙宇晨/灰产/
    // 暴富"），且不再强制"以主体开头"。这些裸查询随下方统一 fan-out 搜索补召回；短词留作
    // 事实门强证据词（来源是用户原句而非系统扩展自造，不构成循环论证）。
    if (entityBlind) {
      const blindExpand = await expandQueries(
        topic,
        cleanTopic(stripAngleLead(topic)),
        "",
        { angleLike: true }
      ).catch(() => null);
      const have = new Set(
        expandQs.map((q) => q.replace(/\s+/g, "").toLowerCase())
      );
      const pushBare = (q0: unknown, max = 14) => {
        const x = String(q0 || "").replace(/\s+/g, " ").trim().slice(0, max);
        if (!x) return;
        const k = x.replace(/\s+/g, "").toLowerCase();
        if (!have.has(k)) {
          have.add(k);
          expandQs.push(x);
        }
      };
      for (const q of blindExpand?.queries || []) pushBare(q);
      // 锚点原子词【必须逐字出现在用户原句里】：模型只负责把长句切成原子词，但实测它会
      // 自作主张加原句没有的相关词（本案原句写"灰产"，模型 keywords 给的却是"割韭菜/
      // 空气币/镰刀"）——非原句词一律不收，扩展词不能反身自证。候选同时取 keywords 与
      // queries 切词（实测模型会把原句原子词放进 query 却漏进 keywords，如本轮的"灰产"）。
      // 保留原大小写：relevanceScore 拉丁词大小写敏感（A11≠a11）。
      const blindTopicNorm = cleanTopic(stripAngleLead(topic))
        .replace(/\s+/g, "")
        .toLowerCase();
      const blindRawToks = [
        ...(blindExpand?.keywords || []),
        ...(blindExpand?.queries || []).flatMap((q) =>
          String(q || "").split(
            /[\s，,。.！!？?；;：:、「」【】《》""''（）()…—~·|]+/
          )
        ),
      ];
      const seenAnchor = new Set<string>();
      for (const t0 of blindRawToks) {
        const k = String(t0 || "").replace(/\s+/g, "").trim();
        if (k.length < 2 || k.length > 8) continue;
        if (!/[一-鿿]/.test(k) && !/[a-zA-Z]{2,}/.test(k)) continue;
        // 过元话语/平台名/日期清洗（可做/一期/微博/9月13日 这类不是证据）
        if (dropNonEvidenceParts([k]).length === 0) continue;
        const kk = k.toLowerCase();
        if (!blindTopicNorm.includes(kk)) continue; // 非用户原句逐字原词，不收
        if (seenAnchor.has(kk)) continue;
        seenAnchor.add(kk);
        blindAnchorKws.push(k);
        // 锚点原子词本身也是最精准的裸搜索（孙宇晨/灰产这种 2-4 字原词站内召回最稳）
        pushBare(k, 12);
        if (blindAnchorKws.length >= 6) break;
      }
    }
    // 显式/启发式角度原词 → 逐词 fan-out（2026-09）：圈内黑话/外号（2-3 字）的站内
    // 唯一索引形态就是原词本身——被主体名或大白话词一修饰，微博/贴吧/知乎站内搜索
    // 反而零召回。所以每个原词【必发一条裸搜】；有主体时再补一条主体限定路。
    // 下方 expandResult.keywords 的注入逻辑保持原样（那条只发主体限定路）。
    {
      const pushUniq = (q: string) => {
        const x = q.replace(/\s+/g, " ").trim();
        if (!x) return;
        const k = x.replace(/\s+/g, "").toLowerCase();
        if (!expandQs.some((y) => y.replace(/\s+/g, "").toLowerCase() === k)) {
          expandQs.push(x);
        }
      };
      for (const kw of angleKws) {
        pushUniq(kw);
        if (entity) pushUniq(`${entity} ${kw}`);
      }
    }
    // 角度大白话短词 → 平台内短查询：微博/贴吧/知乎的站内搜索对长查询几乎零召回，
    // "zont1x 颜值""zont1x 帅"这种 2-3 词短查询才能搜出粉丝讨论帖。
    // 无 entity 的概念查询直接用短词本身（"研发芯片""宗区"）；纯短英文（cs）单搜
    // 噪声太大，要求至少 3 个字母或含汉字。
    if (expandResult?.keywords?.length) {
      for (const kw of expandResult.keywords) {
        if (!entity && !/[一-鿿]/.test(kw) && kw.length < 3) continue;
        const q = (entity ? `${entity} ${kw}` : kw)
          .replace(/\s+/g, " ")
          .trim();
        const k = q.replace(/\s+/g, "").toLowerCase();
        if (
          !expandQs.some((x) => x.replace(/\s+/g, "").toLowerCase() === k)
        ) {
          expandQs.push(q);
        }
      }
    }
    if (expandQs.length) {
      // 侧面查询走 searx 并集 + 平台内爬虫双路（2026-09）：颜值/实力讨论主要
      // 活在微博/贴吧/知乎，只搜 searx 会撞上"通用引擎没索引"的盲区
      const [extraLists, crawlLists] = await Promise.all([
        Promise.all(
          expandQs.map((q) =>
            searxSearchUnion(q, { limit: 12, safesearch: 0 }).catch(
              () => [] as SearchHit[]
            )
          )
        ),
        Promise.all(
          expandQs.map((q) =>
            crawlerSearch(q, { limit: 5 })
              .then(crawlerToHits)
              .catch(() => [] as SearchHit[])
          )
        ),
      ]);
      const extraMerged = [...extraLists, ...crawlLists];
      for (const list of extraMerged) mergeHits(allHits, list);
    }
    // 封闭平台原生内容定向通道（2026-09）：小红书笔记/抖音视频是热点讨论的核心阵地，
    // 但通用检索（core/角度词）里它们的具体内容页排序靠后、常被挤出 limit，参考列表
    // 只剩"小红书搜索/抖音搜索"跳转入口、没有可直接看的原生内容。专开两路带平台名的
    // 检索（百度对"{kw} 抖音"会返回抖音内容页）。注意：这些结果在百度引擎里几乎都是
    // baidu.com/link?url= 包装链，真实目标（douyin.com/video 等）要等下面的统一短链
    // 展开才还原——所以此处【不能】按平台域名预过滤（会把包装链全误杀），而是全量并入
    // allHits（与主检索重复的 mergeHits 按 URL 去重），展开后再由下方"平台保底位"按
    // 真实域名提取。实测小红书笔记被 robots/登录墙封锁、百度/Bing 均不收录具体笔记页，
    // 该路通常召回不到 xiaohongshu.com 直链，保底位拿不到时维持搜索入口兜底。
    // 检索失败一律静默降级，不影响主链路。
    const platformKw = (entity || core).replace(/\s+/g, " ").trim().slice(0, 20);
    if (platformKw) {
      const [dyHits, xhsHits] = await Promise.all([
        searxSearchUnion(`${platformKw} 抖音`, { limit: 12, safesearch: 0 }).catch(
          () => [] as SearchHit[]
        ),
        searxSearchUnion(`${platformKw} 小红书`, { limit: 12, safesearch: 0 }).catch(
          () => [] as SearchHit[]
        ),
      ]);
      if (dyHits.length) mergeHits(allHits, dyHits);
      if (xhsHits.length) mergeHits(allHits, xhsHits);
    }
    // 短链/引擎跳转链展开（2026-09 手机端补丁 + 泛化）：两类包装链都要展开——
    // ① xhslink/v.douyin/b23 这类平台短链：手机点击直接落到登录墙/荒芜页，且前端降级
    //   链需要"正式链接"才能匹配规则（如小红书 explore → xhsdiscover 唤起 App）；
    // ② baidu.com/link?url= / so.com/link / chinaso.com/link / sogou.com/link /
    //   bing.com/ck 这类【搜索引擎跳转包装链】：原样入库会让前端 INDIRECT_URL_RE 命中
    //   "去搜索"标签挂在百家号确切帖头上（明明是正文帖却被当成检索入口），sourceOf
    //   也只能标出"baidu.com"而不是真实来源。展开后真实原文链（如 baijiahao 文章页）
    //   自然走到前台。两类共用一次跟随重定向，失败保底用原链，不阻塞详情生成。
    // ③ 微博访客跳转墙（passport.weibo.com/visitor?…&url=真实帖子链，2026-09 补）：
    //   搜索引擎返回的微博链常被包成访客墙，原样展示时来源是"新浪/passport"且点进去是
    //   登录中间页。这类包装的真实目标直接写在 url 查询参数里，先解参数（零 HTTP），
    //   解不出再跟随重定向。百度/搜狗跳转链的 url/link 参数同理一并先解，省一次请求。
    const wrapTargetFromParams = (raw: string): string => {
      try {
        const u = new URL(raw);
        for (const k of ["url", "target", "to", "redirect", "link"]) {
          const v = u.searchParams.get(k);
          if (!v) continue;
          let cand = v;
          try {
            cand = decodeURIComponent(v);
          } catch {
            /* 非编码原样用 */
          }
          if (/^https?:\/\//.test(cand)) return cand;
        }
      } catch {
        /* URL 非法忽略 */
      }
      return "";
    };
    allHits = await Promise.all(
      allHits.map(async (h) => {
        const isShortLink = /xhslink\.com\/|v\.douyin\.com\/|b23\.tv\//.test(
          h.url
        );
        const isEngineWrap =
          /^https?:\/\/(?:www\.)?(?:baidu\.com\/link[/?]|so\.com\/link[/?]|chinaso\.com\/link[/?]|sogou\.com\/link[/?]|bing\.com\/ck\/?)/.test(
            h.url
          );
        const isVisitorWrap =
          /passport\.weibo/i.test(h.url) && /\/visitor/.test(h.url);
        if (!isShortLink && !isEngineWrap && !isVisitorWrap) return h;
        // 先解查询参数里的真实目标（微博访客墙/百度跳转链都带 url 参数）
        if (isEngineWrap || isVisitorWrap) {
          const paramTarget = wrapTargetFromParams(h.url);
          if (paramTarget && paramTarget !== h.url) {
            return { ...h, url: paramTarget };
          }
        }
        try {
          const res = await fetchWithTimeout(
            h.url,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              },
            },
            5000
          );
          let final = res.url || "";
          // 引擎中转页兜底：baidu/link、bing/ck 对部分结果不回 302，而是回含
          // window.location.replace("…") / meta refresh 的 HTML 壳——res.url 还停在
          // 引擎域名，从响应体里把真实原文链抠出来（只读前 4KB，够放跳转脚本）。
          if ((isEngineWrap || isVisitorWrap) && (!final || !/^https?:\/\//.test(final) || final === h.url)) {
            const head = (await res.text()).slice(0, 4096);
            const m =
              head.match(/window\.location\.replace\(\s*["']([^"']+)["']/) ||
              head.match(/URL=['"]?([^'">\s]+)/i);
            const cand = m?.[1]?.replace(/&amp;/g, "&") || "";
            if (/^https?:\/\//.test(cand)) final = cand;
          }
          if (/^https?:\/\//.test(final) && final !== h.url) {
            return { ...h, url: final };
          }
        } catch {
          /* 展开失败用原链 */
        }
        return h;
      })
    );
    // 展开后二次合并（2026-09）：跳转链展开会改变 URL——searx 的引擎包装链与爬虫的
    // 原文链原本不冲突，展开后指向同一页面，此时再去一次重并补日期/正文
    {
      const before = allHits;
      allHits = [];
      mergeHits(allHits, before);
    }
    const videoRes = allHits.filter((s) => isVideoUrl(s.url));
    const general = allHits.filter((s) => !isVideoUrl(s.url));

    // 文章：general 结果里排除视频站，排序取前 8 条（主体条目按主体名做强相关分层；
    // 扩展查询组参与评分——与任一侧面查询相关即可入选）
    // 排序用原始角度长句（而非搜索用的短关键词 core）——长句里的"361度""颜值""帅出圈"
    // 能精准匹配讨论该角度的帖子；core 只够用来搜索，排序需要更多描述词做锚点
    const rankTopic = angleText || core;
    let sites = rankLoose(
      [general.filter((s) => !isVideoUrl(s.url))],
      rankTopic,
      8,
      entity,
      expandQs
    );
    // 视频：videos 分类结果 + general 里命中的视频链接，排序取前 8 条。
    // looseVideo=true：视频 UGC 多用昵称/梗、角度词直接命中，放宽前排资格（见 rankLoose）。
    let videos: Link[] = rankLoose(
      [videoRes, general.filter((s) => isVideoUrl(s.url))],
      rankTopic,
      8,
      entity,
      expandQs,
      true
    );

    // B站视频直搜兜底（2026-09 评测实证）：searxng 的 bilibili 引擎被整体熔断期间，
    // videos 数组长期为空、只剩搜索词链接。这里用 wbi 签名直连 B站搜索 API，按主体/
    // 话题关键词召回真实视频，本地做相关性词面过滤（标题需命中主体名或核心词）后补入。
    const directVideoCount = videos.filter((v) => !v.search).length;
    if (directVideoCount < 3) {
      const biliKw = (entity || "").trim() || core.replace(/\s+/g, "").slice(0, 14);
      if (biliKw) {
        const biliHits = await biliSearchVideos(biliKw, 6);
        const anchors = new Set(
          [entity, core]
            .join(" ")
            .replace(/\s+/g, "")
            .split(/[，,、。！？!?；;：:（）()【】\[\]"']/)
            .filter((w) => w.length >= 2)
        );
        const seenV = new Set(videos.map((v) => v.url));
        for (const v of biliHits) {
          if (seenV.has(v.url)) continue;
          const t = v.title.replace(/\s+/g, "");
          // 词面相关性：标题命中主体名（或其≥2字片段）/核心词才算，防同名误召回
          const rel =
            !entity ||
            t.includes(entity.replace(/\s+/g, "")) ||
            [...anchors].some((a) => a.length >= 3 && t.includes(a));
          if (!rel) continue;
          videos.push({
            title: v.title,
            url: v.url,
            source: "哔哩哔哩",
            date: v.published,
          });
          seenV.add(v.url);
        }
      }
    }

    // 封闭平台原生内容保底位（2026-09）：平台专路检索的结果经上面的包装链统一展开后，
    // allHits 里已有 douyin.com/video、/note 等真实直链（实测"{主体} 抖音"+百度包装链
    // 展开可拿到），但它们在 rankLoose 综合排序里常被 B站/新闻/贴吧压过、进不了前 8。
    // 故在最终列表生成后做保底：该平台一条【具体内容】都没有（搜索入口不算）时，从展开
    // 后的池子里按主体相关性挑最相关的 1-2 条补入，让用户在参考区能直接点开平台原生
    // 视频/笔记（手机端复用已有 App scheme 唤起链），而不只有"去搜索"入口。
    // 只认真正的内容页：抖音 /video//note（图文）、小红书 explore 笔记；
    // 用户主页/话题/榜单/直播/搜索页一律不算。相关性口径与 B站直搜兜底一致
    //（标题命中主体名或≥3字锚点），防止数字/泛词主体误召回。
    const platformAnchors = new Set(
      [entity, core]
        .join(" ")
        .replace(/\s+/g, "")
        .split(/[，,、。！？!?；;：:（）()【】\[\]"']/)
        .filter((w) => w.length >= 2)
    );
    const platformRelevant = (h: SearchHit) => {
      if (!entity) return true;
      const t = h.title.replace(/\s+/g, "");
      return (
        t.includes(entity.replace(/\s+/g, "")) ||
        [...platformAnchors].some((a) => a.length >= 3 && t.includes(a))
      );
    };
    const DY_CONTENT_RE =
      /(?:douyin\.com|iesdouyin\.com)\/(?:share\/)?(?:video|note)\/\d/;
    const XHS_NOTE_RE =
      /xiaohongshu\.com\/(?:explore|discovery\/item)\/[0-9a-fA-F]{24}/;
    const rankScoreOf = (h: SearchHit) =>
      relevanceScore(`${h.title} ${h.content}`, rankTopic);
    if (!videos.some((v) => DY_CONTENT_RE.test(v.url))) {
      const seenDy = new Set(videos.map((v) => v.url));
      allHits
        .filter(
          (h) =>
            DY_CONTENT_RE.test(h.url) &&
            !seenDy.has(h.url) &&
            platformRelevant(h)
        )
        .sort((a, b) => rankScoreOf(b) - rankScoreOf(a))
        .slice(0, 2)
        .forEach((h) => {
          videos.push({
            title: h.title,
            url: h.url,
            source: "抖音",
            ...(h.published ? { date: h.published } : {}),
          });
          seenDy.add(h.url);
        });
    }
    if (!sites.some((s) => XHS_NOTE_RE.test(s.url))) {
      const seenXhs = new Set(sites.map((s) => s.url));
      allHits
        .filter(
          (h) =>
            XHS_NOTE_RE.test(h.url) &&
            !seenXhs.has(h.url) &&
            platformRelevant(h)
        )
        .sort((a, b) => rankScoreOf(b) - rankScoreOf(a))
        .slice(0, 2)
        .forEach((h) => {
          sites.push({
            title: h.title,
            url: h.url,
            source: "小红书",
            ...(h.published ? { date: h.published } : {}),
            ...(h.content ? { snippet: h.content.slice(0, 150) } : {}),
          });
          seenXhs.add(h.url);
        });
    }

    // 选「核心来源」——既喂给报道当依据，也在参考里打标。
    // 规则：① 优先取与热搜同平台的文章/视频（知乎热搜→知乎、B站→哔哩哔哩…）；
    //       ② 该平台没有直接内容时，退而取相关性最高的其它平台内容；③ 最多 1-3 条。
    const byUrl = new Map(
      [...general, ...videoRes].map((h) => [h.url, h] as const)
    );
    const scoreOf = (l: Link) => {
      const h = byUrl.get(l.url);
      return h ? relevanceScore(`${h.title} ${h.content}`, core) : 0;
    };
    // 候选：文章 + 视频，按与话题的相关性从高到低排（搜索页兜底链接此时还没 push 进来）
    const candidates = [...sites, ...videos].sort(
      (a, b) => scoreOf(b) - scoreOf(a)
    );
    // 把热搜平台名映射到 sourceOf() 产出的来源标签，判断「同平台」
    const platformSources = platformMatchSources(platform || "");
    const samePlatform = candidates.filter((l) =>
      platformSources.includes(l.source)
    );
    // 同平台有内容就优先用同平台（最多 3 条）；否则退回最相关的其它平台内容（最多 2 条）
    const coreLinks =
      samePlatform.length > 0
        ? samePlatform.slice(0, 3)
        : candidates.slice(0, 2);
    const coreUrls = new Set(coreLinks.map((l) => l.url));
    const groundHits = coreLinks
      .map((l) => byUrl.get(l.url))
      .filter((h): h is SearchHit => !!h);

    // 原报道链接：无条件纳入核心来源。置顶为报道取材的第一篇，并保证出现在参考网站/视频里。
    const originIsVideo = originUrl ? isVideoUrl(originUrl) : false;
    if (originUrl) {
      coreUrls.add(originUrl);
      // 作为第一篇取材资料（标题用热点主名称，SearXNG 可能已抓到同链接摘要则复用其正文）
      const existingHit = byUrl.get(originUrl);
      groundHits.unshift(
        existingHit || { title: topic, url: originUrl, content: "" }
      );
    }

    sites = sites.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));
    videos = videos.map((l) => (coreUrls.has(l.url) ? { ...l, core: true } : l));

    // 把原报道置顶到对应列表（去掉已存在的同链接项，再 unshift 到最前，标 core:true）。
    if (originUrl) {
      const existingHit = byUrl.get(originUrl);
      const originLink: Link = {
        title: topic,
        url: originUrl,
        source: sourceOf(originUrl) || (platform || "").toString().trim(),
        core: true,
        ...(existingHit?.published ? { date: existingHit.published } : {}),
        ...(existingHit?.content ? { snippet: existingHit.content.slice(0, 150) } : {}),
      };
      if (originIsVideo) {
        videos = [originLink, ...videos.filter((l) => l.url !== originUrl)];
      } else {
        sites = [originLink, ...sites.filter((l) => l.url !== originUrl)];
      }
    }

    // 报道取材：不局限于「核心来源」那 1-3 条，而是尽量多汇集权威来源交叉核对。
    // 从全部结果里剔除百科/搜索页，按 (相关性 + 权威 + 新鲜度加权) 排序取前 8 条，
    // 再把同平台核心来源并进来去重，一起喂给模型，让它有足够素材还原事实真相。
    // 报道取材池（2026-09修正）：原先只用 general 纯文章——但本案例里带日期的最新进展
    //（"BLAST Open Porto 2026 决赛""zont1x夺冠采访"）全在 B 站视频标题里，文章侧全是
    // 无日期的资料页/百科/贴吧帖，报道永远看不到最新进展。把近半年带日期的视频也纳入
    // 取材池（标题即事实线索，一致性补链时会跳过视频 URL 不污染文章列表），旧视频不进池。
    const freshVideoHits = videoRes.filter(
      (h) => h.published && Date.parse(h.published) >= Date.now() - 180 * 864e5
    );
    // 相关性基础分：对「角度词组（主体名已剥离，同 rankLoose 口径）」取最高分——
    // 生涯资料页不再靠主体名 gram 碾压角度帖
    const reportAngleQs = aspectQueries([core, ...expandQs], entity);
    const baseScore = (h: SearchHit) => {
      const txt = `${h.title} ${h.content}`;
      return Math.max(
        ...(reportAngleQs.length ? reportAngleQs : [core]).map((q) =>
          relevanceScore(txt, q)
        )
      );
    };
    // 强证据词（2026-09，定义前置供取材池名字闸辅路与事实门共用同一口径）：
    //  ①角度契约/引号原词（angleKws，用户/模型从原句摘的原词）；
    //  ②全新造词救援从【用户角度句】里取出的实名锚点（blindAnchorKws，非系统自造）；
    //  ③都没有则剥功能词，并额外去掉平台名/选题元话语/日期残片。剥完为空→无强证据。
    const callerEvidenceQs = Array.from(
      new Set(
        [...angleKws, ...blindAnchorKws].map((q) => q.trim()).filter(Boolean)
      )
    );
    const strictQs = callerEvidenceQs.length
      ? callerEvidenceQs
      : dropNonEvidenceParts(factContentParts(cleanTopic(searchTopic)));
    // 多原词覆盖度证据（与事实门 docEvidence 同模型）：mx=该篇对最强单个原词的分，
    // cov=完整命中（≥3分≈完整命中一个 2-3 字词）的不同原词数。
    const angleDocEvidence = (h: SearchHit) => {
      const txt = `${h.title} ${h.content}`;
      let mx = 0;
      let cov = 0;
      for (const q of strictQs) {
        const s = relevanceScore(txt, q);
        if (s >= 3) cov += 1;
        if (s > mx) mx = s;
      }
      return { mx, cov };
    };
    // 名字闸辅路入池条件（比事实门放行略宽，给互证留第二篇）：mx≥4 或 一篇覆盖≥2 原词。
    const angleBypassAdmit = (h: SearchHit) => {
      if (!entity || strictQs.length === 0) return false;
      const e = angleDocEvidence(h);
      return e.mx >= 4 || e.cov >= 2;
    };
    // 强相关闸（2026-09 第二轮·取材池侧）：rankLoose 对【展示列表】有 t1 强相关分层
    // （文章必须提到主体名），但取材池此前只要求"相关分>0 或 标题/URL 提到主体"——
    // 角度词撞上同名品牌时（"361度"梗 vs 361°运动品牌），天猫店/品牌官网/同名商品帖
    // 只靠角度词 2-gram 就入池，进而：① 喂给报道/素材卡模型，写出"品牌联动"类跑偏内容、
    // 素材事实出现"官方旗舰店正常运营"这种噪声；② 被下方"一致性补链"绕过 rankLoose
    // 分层直接塞进参考网站。这里与 rankLoose 口径对齐：
    // · 文章：有主体时必须（标题+摘要+URL）提到主体名——与文章路 t1 完全一致；
    //   辅路（灰灰男案）：全新造词零索引时，不逐字含主体名的文章凭【用户原句强证据词】
    //   多原词覆盖入池——蹭词品牌帖不可能在单篇内完整命中两个独立原词，防串台不降级；
    // · 近半年视频：提到主体名，或角度整句（≥4字）命中——B 站 UGC 常用昵称/梗不写真名，
    //   但只靠数字品牌词散命中的电商/开箱视频仍挡在外面（与视频路 t1 同口径）。
    const mentionsEntity = (h: SearchHit) =>
      !!entity &&
      `${h.title} ${h.content} ${h.url}`
        .toLowerCase()
        .includes(entity.toLowerCase());
    const articleGate = (h: SearchHit) =>
      !entity || mentionsEntity(h) || angleBypassAdmit(h);
    const videoGate = (h: SearchHit) => {
      if (!entity) return true;
      if (mentionsEntity(h)) return true;
      const txt = normRefText(`${h.title} ${h.content}`);
      return strongAngleHit(txt, reportAngleQs.length ? reportAngleQs : [core]);
    };
    const poolGeneral = general.filter(
      (h) => !isGenericRef(h.url) && articleGate(h)
    );
    const poolVideos = freshVideoHits.filter(
      (h) => !isGenericRef(h.url) && videoGate(h)
    );
    const reportRanked = [...poolGeneral, ...poolVideos]
      .map((h) => ({
        h,
        s:
          baseScore(h) +
          (isAuthoritative(h.url) ? 3 : 0) +
          // 新鲜度阶梯加权（2026-09 同题评测升级）：原"近半年 +2"窗口太宽——油价题里
          // 4 个月前的旧调价窗口文章照样排前，报道把"5月21日调价"当成"下一次"。改为：
          // 近3天 +6 / 近14天 +3 / 近半年 +1 / 更旧 0，让"下一次调价=10月10日"这类
          // 最新进展稳定压过旧闻；旧闻不丢弃（历史背景仍可入池）但相对靠后。
          (h.published
            ? Date.parse(h.published) >= Date.now() - 3 * 864e5
              ? 6
              : Date.parse(h.published) >= Date.now() - 14 * 864e5
                ? 3
                : Date.parse(h.published) >= Date.now() - 180 * 864e5
                  ? 1
                  : 0
            : 0),
      }))
      .filter(
        // 提到主体名 = 相关，保底进取材池；名字闸辅路证据篇同口径保底
        (x) => x.s > 0 || mentionsEntity(x.h) || angleBypassAdmit(x.h)
      )
      .sort((a, b) => b.s - a.s)
      .map((x) => x.h);
    const reportSeen = new Set<string>();
    const reportHits: SearchHit[] = [];
    for (const h of [...groundHits, ...reportRanked]) {
      if (reportSeen.has(h.url)) continue;
      reportSeen.add(h.url);
      reportHits.push(h);
      if (reportHits.length >= 8) break;
    }

    // 事实门（2026-09 根治，取代旧的前置 LLM 措辞猜测门）。
    // 唯一口径：【检索之后】看有没有召回与话题强相关的事实，与领域/措辞/语言/长短无关：
    //  A. 有平台核心来源（groundHits）或原报道链接 → 应用内热榜单条点入，事实确定，放行；
    //  B. 调用方【明确给了】讨论主体（entityFromCaller）且取材池里【至少一篇逐字提到
    //     主体名】→ 名字闸已保证该篇锚定主体，放行；guessEntity 猜出来的主体不算——
    //     它可能是从跑偏召回里猜中的随机新闻人物，拿它给同一批召回自证是循环论证；
    //     全新造词救援（没有一篇含主体名）不走此路，必须落到 C 的多原词互证；
    //  C. 无结构上下文（裸话题/切入句，含猜测主体落空的情况）→ 要求确定性强相关证据：
    //     至少 1 篇对原词打分≥5（完整命中长专名）或一篇覆盖≥2 个不同原词（多个圈内黑话
    //     同时完整命中），且总共≥2 篇达到 mx≥4/cov≥2 互证。"那个事后来怎么样了""你引用了
    //     哪些网站"剥完没有鉴别性实词，必然落到这里被闸住，与问的是哪个领域无关。
    // 闸住时不调用生成模型、不硬答一篇，直接告诉用户没查到、建议补具体主体。
    // 强证据词口径（strictQs 已前置到取材池定义）：只取自【用户原始输入】——角度契约
    // 原词、引号原词、全新造词救援从用户角度句里取出的实名锚点；都没有才剥功能词。
    // 绝不碰 LLM 自由扩展的 expandQs——那是系统造的宽召回词，不能反过来自证。
    // 证据模型（2026-09 覆盖度升级）：旧口径"取单词条最高分、要求 1 篇≥5"对 2-3 字
    // 圈内黑话结构性关门——3 字词满分才 4（2gram×2 + 完整 2），永远过不了 5。
    // 单看散命中又会被"称呼/提问"这类泛词骗开。故按【多原词覆盖】判强证据：
    // · mx：该篇对最强单个原词的分（完整长专名仍走老的 ≥5 通道）；
    // · cov：该篇命中（≥3 分≈完整命中一个 2-3 字词）的不同原词数——同一篇同时
    //   完整命中两个圈内词，随机蹭词帖做不到，等价于强证据；
    // 强证据篇 mx≥5 或 cov≥2；至少 1 篇强证据 + 总共 2 篇（mx≥4 或 cov≥2）互证。
    // 含主体名的篇沿用旧口径（baseScore 角度分）；名字闸辅路救回的篇（全新造词救援）
    // 必须用用户原句证据词覆盖度自证，不能靠"调用方给了主体"豁免。
    const factEvidences = reportHits.map((h) => ({
      h,
      ...(entityFromCaller && mentionsEntity(h)
        ? { mx: baseScore(h), cov: 0 }
        : angleDocEvidence(h)),
    }));
    const factScores = factEvidences.map((e) => e.mx);
    const factStrong =
      strictQs.length > 0 &&
      factEvidences.some((e) => e.mx >= 5 || e.cov >= 2) &&
      factEvidences.filter((e) => e.mx >= 4 || e.cov >= 2).length >= 2;
    //  A. 应用内结构化入口：热榜单条点入（带 platform 且有平台核心来源）或带原报道链接 →
    //     事实确定，放行。注意无 platform 时 groundHits 只是 SearXNG 召回的前两条、
    //     不是"平台核心来源"，不能作为证据——否则任何垃圾检索都能靠它自证放行。
    //  B. 调用方【明确给了】主体，且取材池至少一篇逐字提到主体名（旧口径原样）；
    //     全靠名字闸辅路救回的篇不算确定事实，必须走 C 多原词互证。
    const poolHasEntityHit = reportHits.some(mentionsEntity);
    const factEnough =
      (!!platform && groundHits.length > 0) ||
      !!originUrl ||
      (entityFromCaller && poolHasEntityHit && reportHits.length > 0) ||
      factStrong;
    if (!factEnough) {
      return NextResponse.json({
        needClarify: true,
        report: `没有找到与「${topic.slice(0, 60)}」直接相关的公开资料——可能是话题里缺少具体的人物、事件或作品名。换个更具体的说法（带上名字/时间/地点）我再帮你查。`,
        sites: [],
        videos: [],
        searchMeta: {
          queries: Array.from(new Set([core, ...expandQs].filter(Boolean))),
          candidates: allHits.length,
          strongFacts: factScores.filter((s) => s >= 5).length,
        },
      });
    }

    // 一致性保证：报道是【严格依据 reportHits 这几篇资料】生成的，所以这几篇【必须】全部出现在
    // 用户可见的「参考网站」里，否则会出现"报道引用了参考资料里根本没有的来源（如原帖）"的问题。
    // 这里把 reportHits 里尚未展示的文章补进 sites（保留已算好的相关性排序与 core 标记，缺的追加到末尾）。
    const shownSiteUrls = new Set(sites.map((l) => l.url));
    for (const h of reportHits) {
      if (isVideoUrl(h.url) || shownSiteUrls.has(h.url)) continue;
      shownSiteUrls.add(h.url);
      sites.push({
        title: h.title,
        url: h.url,
        source: sourceOf(h.url),
        core: coreUrls.has(h.url) || undefined,
        ...(h.published ? { date: h.published } : {}),
        ...(h.content ? { snippet: h.content.slice(0, 150) } : {}),
      });
    }

    // 严格依据搜集到的多篇权威来源生成：①基本资料（仅主体条目，讲"这条切入所讲事件
    // 的基本盘"，主体百科已在上方【主体速览】讲过）②详细报道 ③口播素材卡
    //（并行，复用同一批资料）。
    // 出生日期探测同批并行（零额外延迟），给出口年龄守卫提供真相源。
    const [reportRaw, material, profileRaw, birthBlock] = await Promise.all([
      genReport(topic, platform || "", reportHits, entity),
      genMaterial(topic, platform || "", reportHits, entity),
      genProfile(entity, topic, reportHits),
      probeBirthBlock(entity),
    ]);
    // 年龄守卫（2026-09 第二轮）：报道/简介与脚本同口径——资料里的出生日期是唯一真相，
    // 旧报道"今年17"类过时年龄断言按今天折算修正；只改"当前年龄"断言，历史叙事不碰。
    const ageSrc = `${reportHits
      .map((h) => `${h.title} ${h.content}`)
      .join("\n")}\n${birthBlock}`;
    let report = fixAgeClaims(ageSrc, reportRaw).text;
    const profile = profileRaw ? fixAgeClaims(ageSrc, profileRaw).text : profileRaw;
    // 价格数字确定性脱敏（2026-09 评测实证）：大模型对"行业通行价格"有极强参数记忆，
    // prompt 加固后仍会把记忆中的 API 单价写进报道，且下游脚本会忠实抄写扩散。
    // 报道/素材卡里凡资料原文无同数字出处的人民币金额，一律泛化替换。
    const corpus = ageSrc;
    report = redactUngroundedPrices(report, corpus);
    if (material) {
      material.oneLine = redactUngroundedPrices(material.oneLine || "", corpus);
      const scrubText = (v: any): any =>
        typeof v === "string" ? redactUngroundedPrices(v, corpus) : v;
      if (Array.isArray(material.memes))
        material.memes = material.memes.map((x: any) =>
          x && typeof x === "object" ? { ...x, t: scrubText(x.t || "") } : scrubText(x)
        );
      if (Array.isArray(material.facts))
        material.facts = material.facts.map((x: any) =>
          x && typeof x === "object" ? { ...x, t: scrubText(x.t || "") } : scrubText(x)
        );
      if (Array.isArray(material.timeline))
        material.timeline = material.timeline.map((x: any) =>
          x && typeof x === "object" ? { ...x, t: scrubText(x.t || "") } : scrubText(x)
        );
      if (Array.isArray(material.angles))
        material.angles = material.angles.map((x: any) => scrubText(x));
    }

    // 站内/兜底搜索链接的检索词（2026-09 第三轮重写）：小红书/微博/抖音的 App 内搜索框
    // 对长句几乎零召回——整句（"AI游戏世界生成 是2026年持续火热的技术话题…"）或半截
    // 残词（"平民化玩法"被 8 字硬截成"的平"）扔进去都是空结果。检索词必须【短】且
    // 【两头契合】：主体名（贴合用户输入的原始主题）+ 一个角度短词（贴合点详情前的
    // 切入标题），总长 ≤14 字。角度短词优先级：
    //  ① 语义拆解产出的网友大白话短词（expandResult.keywords，2-4 字、含汉字，本就为
    //     平台内短词检索设计，如"开世界""颜值""回归"）；
    //  ② 本地角度提取（数字梗词如"361度"、预定义描述词，天然是短词）；
    //  ③ 角度句【首个分句】前 6 字（按原标点切；cleanTopic 会把逗号变空格导致切不开——
    //     旧逻辑 8 字截断正是踩了这个坑，截出"一句话开世界的平"这种残词）。
    // 组合后超 14 字就只留主体名单独搜（主体名本身召回已足够，不硬塞残词）。
    const appSearchKW = (() => {
      const ent = (entity || "").trim();
      const escEnt = ent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const angleOnly = ent ? topic.replace(new RegExp(escEnt, "gi"), " ") : topic;
      const entC = ent.replace(/\s+/g, "");
      const usable = (k: string) => {
        const kc = (k || "").replace(/\s+/g, "");
        return (
          kc.length >= 2 &&
          kc.length <= 6 &&
          /[\u4e00-\u9fa5]/.test(kc) &&
          !(entC && entC.includes(kc)) // 已是主体名一部分的词不加（ narrowing 不了）
        );
      };
      // ① LLM 大白话短词
      let kw = (expandResult?.keywords || []).find(usable) || "";
      // ② 本地角度提取（数字梗/预定义描述词）
      if (!kw) {
        const local = (extractAngleKeywords(topic, ent)[0] || "").replace(
          /\s+/g,
          ""
        );
        if (usable(local)) kw = local;
      }
      // ③ 角度句首个分句取前 6 字（中文分句开头通常是完整短语："一句话开世界"）
      if (!kw) {
        const firstClause =
          angleOnly
            .split(/[，；。！？、;!?]+/)
            .map((s) => s.replace(/\s+/g, "").trim())
            .find((s) => s.length >= 3) || "";
        const frag = firstClause.slice(0, 6);
        if (frag.length >= 3) kw = frag;
      }
      const kwC = kw.replace(/\s+/g, "");
      if (entC && kwC && entC.length + kwC.length + 1 <= 14)
        return `${ent} ${kw}`;
      if (entC) return ent; // 组合超长 → 主体名单独搜，不拼残词
      return (kwC || core.replace(/\s+/g, "")).slice(0, 14);
    })();
    const q = encodeURIComponent(appSearchKW);
    // 兜底：确实没搜到任何关联内容时才退回搜索页链接（search:true → 前端挂「去搜索」标签）
    if (sites.length === 0) {
      sites = [
        {
          title: `百度搜索：${appSearchKW}`,
          url: `https://www.baidu.com/s?wd=${q}`,
          source: "百度",
          search: true,
        },
        {
          title: `知乎搜索：${appSearchKW}`,
          url: `https://www.zhihu.com/search?type=content&q=${q}`,
          source: "知乎",
          search: true,
        },
      ];
    }
    if (videos.length === 0) {
      videos = [
        {
          title: `B站搜索：${appSearchKW}`,
          url: `https://search.bilibili.com/all?keyword=${q}`,
          source: "哔哩哔哩",
          search: true,
        },
      ];
    }

    // 封闭平台（App 内闭环、爬不到具体内容）——固定追加"站内搜索"跳转入口。
    // 小红书 / 微博 放在参考网站末尾，抖音 放在参考视频末尾。
    sites.push(
      {
        title: `小红书搜索：${appSearchKW}`,
        url: `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`,
        source: "小红书",
        search: true,
      },
      {
        title: `微博搜索：${appSearchKW}`,
        url: `https://s.weibo.com/weibo?q=${q}`,
        source: "微博",
        search: true,
      }
    );
    videos.push({
      title: `抖音搜索：${appSearchKW}`,
      url: `https://www.douyin.com/search/${q}?type=general`,
      source: "抖音",
      search: true,
    });

    // 参考视频补发布日期（2026-09 用户反馈"视频大多数没有日期"）。两类视频的日期此前必缺：
    // SearXNG 的 bilibili 引擎结果常不带 publishedDate；抖音视频经百度包装链展开后只有
    // 标题+URL。只用【权威/确定性】来源补，查不到就不标、绝不臆造：
    // ① B站：按 bvid 调视频详情接口（无需 wbi 签名，实测 code=0）取权威 pubdate；
    // ② 抖音：aweme_id 为雪花 ID，高 32 位即发布 Unix 秒级时间戳（社区多份文档一致 +
    //   实测推导日期与视频实际发布窗口吻合），按北京时间（UTC+8）折算 YYYY-MM-DD；
    //   只接受 2016 年至今的合理范围，异常值不标。
    // 小红书笔记 ID 是随机 24 位十六进制串、不含时间信息，无法推导，保持无日期。
    const BILI_VID_RE = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/;
    const DY_VID_RE =
      /(?:douyin\.com|iesdouyin\.com)\/(?:share\/)?(?:video|note)\/(\d+)/;
    const videosNeedingDate = videos.filter((v) => !v.date && !v.search);
    if (videosNeedingDate.length) {
      const bvids = videosNeedingDate
        .map((v) => BILI_VID_RE.exec(v.url)?.[1])
        .filter((x): x is string => !!x);
      const biliDateMap = bvids.length
        ? await biliVideoDates(bvids).catch(() => new Map<string, string>())
        : new Map<string, string>();
      const DY_MIN_TS = Math.floor(
        new Date("2016-01-01T00:00:00+08:00").getTime() / 1000
      );
      const DY_MAX_TS = Math.floor(Date.now() / 1000) + 86400;
      const dyDateOf = (url: string): string | undefined => {
        const m = DY_VID_RE.exec(url);
        if (!m) return undefined;
        const ts = Number(m[1]) >> 32;
        if (!Number.isFinite(ts) || ts < DY_MIN_TS || ts > DY_MAX_TS)
          return undefined;
        return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
      };
      videos = videos.map((v) => {
        if (v.date || v.search) return v;
        const bv = BILI_VID_RE.exec(v.url)?.[1];
        const d = (bv ? biliDateMap.get(bv) : undefined) || dyDateOf(v.url);
        return d ? { ...v, date: d } : v;
      });
    }

    // 检索过程透明化（学自千问"已完成分析，共参考 N 篇资料"的实测观察 2026-09）：
    // 把本次详情检索实际用的关键词、候选池规模、各召回路命中数暴露给 API 调用方，
    // 前端是否展示、怎么展示由调用方决定。
    const searchMeta = {
      queries: Array.from(new Set([core, entity, ...expandQs].filter(Boolean))),
      candidates: allHits.length,
      channels: {
        webSearch: angleHits.length + entityHits.length,
        platformCrawl: crawlerHits.length,
        flashNews: flashHits.length,
      },
      sites: sites.length,
      videos: videos.length,
    };

    // 评测探针（仅 _evalGround 时返回，不影响正常用户）：把报道/简介/素材的真实取材依据
    // （reportHits 标题+摘要）回传，供离线事实忠实度评测做证据核对。
    const evalGround = _evalGround
      ? {
          ground: reportHits.slice(0, 8).map((h) => ({
            title: h.title,
            url: h.url,
            ...(h.published ? { published: h.published } : {}),
            content: (h.content || "").slice(0, 1500),
          })),
        }
      : {};
    return NextResponse.json({ report, sites, videos, material, profile, searchMeta, ...evalGround });
  } catch (e: any) {
    // Key 缺失/无效/欠费/限流：返回结构化引导，前端详情面板渲染「配置 Key / 去充值」按钮
    const action = llmErrorAction(e);
    if (action) {
      return NextResponse.json(
        { report: action.message, sites: [], videos: [], material: null, llmError: action },
        { status: action.httpStatus }
      );
    }
    return NextResponse.json(
      { report: `详情获取失败：${e.message}`, sites: [], videos: [], material: null },
      { status: 500 }
    );
  }
}

// 基本资料（详情面板第一块）：用户是从聊天里的某条具体切入点开的详情，上方聊天正文
// 的【主体速览】已经介绍过"这人/物是谁"，所以这里严禁再写人物百科；要交代的是
// 【这条切入所讲事件本身的基本盘】——什么事、涉及谁和谁、何时何地、结果/进展、分量。
// 与报道同一取材标准：只写检索资料能交叉确认的事实，宁缺毋滥；不足时返回空串。
async function genProfile(
  entity: string,
  topic: string,
  hits: SearchHit[]
): Promise<string> {
  if (!getLlm().apiKey || !entity) return "";
  const material = hits
    .slice(0, 8)
    .map((h, i) => `【来源${i + 1}｜${sourceOf(h.url)}】${h.title}｜${h.content}`.trim())
    .filter((s) => s.length > 6)
    .join("\n");
  if (!material) return "";
  const prompt = `下面是关于「${entity}」的多篇真实检索资料，用户是从「${topic}」这条具体内容点进来的：\n${material}\n\n请提炼这条内容【所讲事件本身】的基本资料，作为详情页第一块"事件背景卡"。注意：用户在上方已经看过「${entity}」是谁的简介，这里【严禁】重复人物/主体百科。\n要写的是这件事的基本盘（资料实际有什么写什么，不凑）：\n1. 这是件什么事：事项/赛事/项目/争议的名称与性质；\n2. 涉及哪些方：「${entity}」与谁一起或对谁（团队、对手、合作方、相关机构）；\n3. 关键的时间、地点、场合；\n4. 结果或当前进展，外加一句话关键过程（怎么发生的）；\n5. 若资料有明确说法，这事的分量或受关注原因。\n硬性要求：\n1. 2-4 句、总量不超过 130 字，中文，直接陈述，不要分点、不要标题、不要语气词；\n2. 只写资料里可以确认的信息：数字（日期/比分/名次/成绩/金额）必须与资料原文一致，资料没有的数字一律不写；各来源冲突或无法确认的信息直接略去；\n3. 「${entity}」自身的身份属性（国籍、职业、职位、司职、生平、所属队伍或公司等百科信息）一律不写——只有理解该事件不可缺的限定时，最多半句带过；\n   【年龄口径】今天是 ${new Date().toISOString().slice(0, 10)}：资料有出生日期的，当前年龄按今天折算（今年减出生年、今年生日没过再减一）；旧报道里的"今年17""N岁少年"是该报道当时的年龄，严禁当成现在年龄写；资料没有出生日期就不写年龄数字。胜负、名次这类硬事实资料间冲突时，以带日期最新的资料为准，判不定的略去；\n4. 若资料全是主体百科、完全不足以交代该事件（什么事、涉及方、时间、结果都没有），只输出两个字：无。`;
  try {
    const llm = getLlm();
    const res = await fetchWithTimeout(
      `${llm.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      15000
    );
    const json = await res.json();
    const txt = String(json.choices?.[0]?.message?.content || "").trim();
    if (!txt || txt.length <= 3 || /^无[。.\s]*$/.test(txt)) return "";
    // 兜底：剥掉模型偶发自加的"基本资料："类前缀标题
    return txt.replace(/^[#*\s]*基本资料[：:]*\s*/, "").trim();
  } catch {
    return "";
  }
}

// 价格数字确定性脱敏统一在 src/lib/priceGuard.ts（报道/素材卡/口播稿同口径）。

async function genReport(
  topic: string,
  platform: string,
  hits: SearchHit[],
  entity = ""
): Promise<string> {
  if (!getLlm().apiKey) {
    return `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
  }
  // 用真实搜索到的多篇权威来源当作依据，交叉核对后提炼事实，避免凭空臆测
  const material = hits
    .slice(0, 8)
    .map((h, i) => `【来源${i + 1}｜${sourceOf(h.url)}】${h.title}｜${h.content}`.trim())
    .filter((s) => s.length > 6)
    .join("\n");
  const hasMaterial = material.length > 0;
  const from = platform ? `（来自${platform}热榜）` : "";
  // 主线纪律（所有条目通用）：报道只讲本条热点这一条主线，主体其他领域的杂闻一律舍弃。
  // 这是根治"一段里一会儿谈恋爱、一会儿荣誉、一会儿采访金句"拼盘式报道的关键约束。
  const mainlineRule = `\n6. 【主线纪律】本条热点的主线是「${topic}」。报道只围绕这条主线组织（涉及的对象是谁 + 与主线直接相关的事实与近况）；相关与否看【语义】而非字面——与主线同一核心主题、只是措辞不同的内容（如主张相同的不同发言）属于主线，可以写；仅主体相同但讲别的事的仍属无关。与主线无关的同一主体信息——其他领域动态、旧荣誉盘点、感情/私人生活、游戏设置与装备参数、其他场合的言论等——即使资料里有也【一律不写】。宁可短，也【严禁】把主体的各类杂闻拼成一篇"主体百科"；写完自检：每一句是否都在讲「${topic}」这条主线，不是就删掉。`;
  // 主体条目：报道必须以主体本身为核心展开，选中的切入角度只是视角，禁止泛泛谈角度概念
  const entityRule = entity
    ? `\n7. 这条内容来自主体「${entity}」的方向区条目：报道必须【以「${entity}」本身为核心】展开（它是谁/现状/与该角度相关的具体事实），当前话题「${topic}」只是切入视角——【严禁】脱离主体泛泛而谈角度概念本身，写的内容要能让用户看完更了解「${entity}」这个人/事物/事件本身。`
    : "";
  // 时效基准：模型不知道"今天几号"，而不限时检索召回的资料又多为旧报道——
  // 不锚定时间就会出现"把2025年9月的下放当新闻写，2026年已回归夺冠却不提"的过时稿
  const today = new Date().toISOString().slice(0, 10);
  const freshRule = `\n8. 【时效基准】今天是 ${today}。报道必须以资料中【最新的事实状态】为叙述基准：同一主体/事件在资料里有多个时间点的进展时（如下放→回归→夺冠），必须写到最新进展为止，旧事件只作一句背景铺垫（"曾于…，此后…"），【严禁】把已被新进展取代的旧状态当成现状来写；资料条目带日期的，优先采信日期更新的说法。人物/战队的当前队伍、是否在位/首发、近期主要成绩与头衔属于必须交代准确的【现状信息】，不受第6条主线纪律限制——资料里有就先用一两句把现状锚定，再展开主线。关键进展句要带上时间表述（如"近日""9月初"），让读者看得出现状是新的。\n9. 【年龄口径】人物当前年龄必须按今天的时点写：资料里有出生日期的，按"今年减出生年、今年生日没过再减一"折算；旧报道里的"今年17""19岁少年"是【该报道发布当时】的年龄，严禁当成现在的年龄写进现状；资料里没有出生日期的，不写具体年龄数字。胜负、名次、是否夺冠这类硬事实若资料间互相冲突，以带日期最新的资料为准，判不定的直接略去。\n10. 【旧闻禁令】涉及"下一次／最近／最新／即将／近期"表述的事实（如下一次调价时间、最近一场比赛结果、最新产品发布、最新数据发布），必须核对资料中该事实的日期：只有日期在今天之后（未来窗口）或近 7 天内的事实才允许这样表述；资料里日期早于近 14 天的旧事实（如上个月甚至几个月前的旧调价窗口、旧比赛、旧发布）【严禁】写成"下一次/最近/最新"——要么不写，要么明确给出原始日期作为历史信息呈现（如"据5月21日的报道"）。一篇 2009 年的比赛结果、一个 4 个月前的调价窗口出现在"最近/下一次"的语境里就是重大事故。\n11. 【日期标注】报道中每个事实点都必须带明确的时间锚——具体日期（"9月10日""2026年8月31日"）或"今日/昨日/本周/8月底/近日"——没有时间锚的事实句不得出现（纯粹的定义/常识背景句除外）。读者必须能从报道里看出每件事发生在什么时候。`;
  // 事实零补充（2026-09 评测实证）：模型会用自己的背景知识给报道"加料"——案件资料没提的
  // 相关人物姓名（如其他当事人）、"多家媒体实地探访/权威信源交叉印证/司法程序仍在推进/
  // 引发网友热议"这类资料中无对应表述的程式化套话。报道的每一个具体事实都必须能指认到来源。
  const evidenceRule = `\n12. 【事实零补充】你自己背景知识里记得、但上面资料【没写】的"事实"——其他当事人/关联人物姓名、历史旧案细节、行业惯例、任何精确数字——一律不许写进报道；也禁止"多家媒体实地探访""权威信源交叉印证""司法程序仍在推进""引发网友热议""评论区已炸锅"这类资料中没有对应表述的程式化套话。特别警告：价格/费用/单价/降价幅度是凭记忆写错的最高发区——你或许记得某家公司、某类产品"通常"的定价数字，但资料原文没有出现的价格/费用数字，【一个都不许写】，哪怕你确信记忆没错；资料只说"更便宜/降价"就不许出现具体金额。【状态变动事件】同理：某人离职/被换/出任新职、节目主持换班、公司倒闭或被收购、人物去世、被调查、婚变、退网这类"身份/命运转折点"事件，只有资料原句明确写了才许写；资料只在讨论与此人相关的别的事，【严禁】顺手把你印象里他的旧职务、旧变动、今年4月/年初发生过什么之类当成事实塞进报道。写完逐句自检：每个具体人名、数字、日期、引语都必须能在资料原文里指认出来源，指认不出的立刻删掉。`;
  const prompt = hasMaterial
    ? `以下是关于热点话题「${topic}」${from}的多篇真实搜索资料（含多个来源）：\n${material}\n\n请你像记者核实新闻一样，对照这几篇来源交叉比对，提炼出多篇来源【一致确认】的事实，写成一段简明清晰的详细报道，说明这个热点具体指什么、事件的来龙去脉与关键信息。硬性要求：\n1. 只写多篇来源共同支撑、可以确定的事实真相，表述要明确、肯定；\n2. 对于个别来源提到但无法确认、或各来源说法冲突的细节，直接【略去不写】，不要把它写进报道；\n3. 【严禁】出现"资料未明确""尚不可知""无法确认""未提供原文""细节不详"这类含糊、留白的措辞——报道里呈现的每一句都应是已核实的确定信息；\n4. 绝对不得臆测或编造资料中没有的内容；赛事/活动名称必须照抄资料里的原始全名（如"BLAST Open Porto 2026"），【严禁】自行改写赛名、届数、举办地或年份（资料没写就别写）；\n5. 【严禁提及上述资料清单之外的任何来源、平台或帖子】——不要写"某贴吧帖子""某讨论帖""可作为……的素材"这类点评式、指向具体出处的话；报道只陈述事件本身，不描述"信息来自哪里"，因为你只能看到上面这几条资料，臆测原始出处会与用户看到的参考链接对不上。${mainlineRule}${entityRule}${freshRule}${evidenceRule}\n控制在 200-320 字，中文，客观清晰，直接成段叙述，不要分点、不要加标题、不要罗列来源。`
    : `请就热点话题「${topic}」${from}写一段简明的详细报道（今天是 ${today}，一切"现状"按今天的时点来写），包含事件背景、关键信息、各方观点或影响。${entity ? `报道必须【以「${entity}」本身为核心】展开，当前话题只是切入视角，不要泛泛而谈。` : ""}若你并不确定该词的确切含义，请说明「暂无足够公开信息」，不要编造，也不要臆测信息来自某个具体帖子或来源。控制在 200-300 字，中文，客观清晰，直接成段叙述。`;
  try {
    const llm = getLlm();
    // 走 llmChatJson：Key 无效/欠费/限流抛 LlmApiError，必须冒泡到顶层 catch
    // 给用户「配 Key / 去充值」引导——不能像网络抖动那样吞成"暂时无法生成"兜底文案。
    const json = await llmChatJson(
      llm,
      { messages: [{ role: "user", content: prompt }] },
      60000
    );
    return (
      json.choices?.[0]?.message?.content ||
      `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`
    );
  } catch (e) {
    if (e instanceof LlmApiError) throw e;
    return `关于「${topic}」的详细报道暂时无法生成，可点击下方参考链接查看更多信息。`;
  }
}

// 口播素材卡：从同一批真实资料里提炼「能直接用进口播稿」的东西，
// 让创作者不必逐条点开链接，就能判断这条热点值不值得做、有什么梗可用、能怎么切入。
type Material = {
  oneLine: string;
  memes: string[];
  angles: string[];
  timeline: string[];
  facts: string[];
  thin?: boolean;
} | null;

// ===== 素材卡确定性后校验：杀掉模型编造的"金句/数据/时间线" =====
// 原理：编造的内容不会在检索原文里出现。全角数字/空白归一后做包含检查，
// 数字指纹必须全中，文本指纹取"与原文的最长公共子串 ≥6 字"——改写、换序都能靠
// 原文锚点（数字/专有名词）存活，凭空创作的口吻句会挂。宁缺毋滥。
const normTxt = (s: string) =>
  s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "");

// 时间线/事实去重（与 prompt"时间线优先、事实只做补充"双保险）：
// 事实条与任一时间线条目讲同一件事（包含关系或字符 bigram 高重合）就丢弃，
// 根治素材卡里"时间线"和"可引用事实"两块逐字重复。
const normForDup = (s: string) =>
  normTxt(s)
    .toLowerCase()
    .replace(/[\p{P}\p{S}，。、；：？！「」『』【】（）《》“”‘’…—·｜|]/gu, "");
const bigrams = (s: string): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
};
function factCoveredByTimeline(fact: string, timeline: string[]): boolean {
  const f = normForDup(fact);
  if (f.length < 4) return false;
  for (const t of timeline) {
    const tt = normForDup(t);
    if (!tt) continue;
    if (tt.includes(f) || (f.length >= 10 && f.includes(tt))) return true;
    const A = bigrams(f);
    const B = bigrams(tt);
    let inter = 0;
    A.forEach((g) => {
      if (B.has(g)) inter++;
    });
    const union = A.size + B.size - inter;
    if (union > 0 && inter / union >= 0.55) return true;
  }
  return false;
}

// 时间线确定性政策（2026-09，内容中立——只看时间结构，不针对任何领域）：
// ①每条必须带明确时间锚：没有日期的"进展"不是时间点，剔除后仍可留在 facts；
// ②年份窗口：条目自己写出的年份、或其可溯源资料的发布年份，必须落在窗口内——
//   话题自带年份 Y → 窗口 [Y-1, Y]；否则 [今年-1, 今年]。新事件的时间线不许混入
//   多年前的旧产品/旧事件节点（2026 年新机开售混入 2024 年首代首售）；
// ③存活不足 2 条 → 单点不构成连续脉络，整条取消（非连续发展事件不硬做时间线）。
const TIMELINE_ANCHOR_RE =
  /((?:19|20)\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月|今日|今天|今早|今晚|昨日|昨天|本周|上周|近日|近期|当天|当日|次日|首日|凌晨)/;
function filterTimeline(
  items: string[],
  topic: string,
  hits: SearchHit[]
): string[] {
  const thisYear = new Date().getFullYear();
  const topicYear = queryPlan(topic).context
    .map(Number)
    .find((y) => y >= 1970 && y <= 2100);
  const maxY = topicYear || thisYear;
  const minY = topicYear ? topicYear - 1 : thisYear - 1;
  const yearOk = (y: number) => y >= minY && y <= maxY;
  const kept: string[] = [];
  for (const item of items) {
    if (!TIMELINE_ANCHOR_RE.test(item)) continue;
    const yearsIn = (item.match(/(?:19|20)\d{2}/g) || []).map(Number);
    // 条目自己写了年份：至少一个落在窗口内（同条连续叙述里新旧年份并陈时放行）
    if (yearsIn.length && !yearsIn.some(yearOk)) continue;
    // 条目没写年份：其内容必须在一条窗口内发布的资料里出现 ≥6 字公共片段，
    // 防"9月10日"式跨年旧闻。只看文本片段，不要求时间/数字同源（条目常是
    // 多条来源合并：精确时间来自 A 帖、价格数据来自 B 稿）。
    if (!yearsIn.length) {
      const segs = item
        .split(/[，。！？、：；""''「」『』（）()!?,.:;~～…—\s]+/)
        .map((s) => normTxt(s))
        .filter((s) => s.length >= 6);
      const freshAttested = hits.some((h) => {
        const y = h.published ? new Date(h.published).getFullYear() : NaN;
        if (!y || !yearOk(y)) return false;
        const raw = normTxt(`${h.title} ${h.content || ""}`);
        return segs.some((s) => hasCommonChunk(s, raw, 6));
      });
      if (!freshAttested) continue;
    }
    kept.push(item);
  }
  return kept.length >= 2 ? kept : [];
}

// 短串 aNorm 与原文 bNorm 是否存在 ≥min 字的公共子串
function hasCommonChunk(aNorm: string, bNorm: string, min: number): boolean {
  if (aNorm.length < min) return false;
  for (let L = aNorm.length; L >= min; L--) {
    for (let i = 0; i + L <= aNorm.length; i++) {
      if (bNorm.includes(aNorm.slice(i, i + L))) return true;
    }
  }
  return false;
}

function checkTraces(entry: string, rawNorm: string): boolean {
  const e = normTxt(entry);
  // 数字指纹：条目里每个 ≥2 位数字段（1750/2026/1.4）都必须在原文中出现
  const nums = e.match(/\d{2,}(?:\.\d+)?/g) || [];
  for (const n of nums) {
    if (!rawNorm.includes(n)) return false;
  }
  // 文本指纹：按标点切片段，任一 ≥6 字片段与原文有 ≥6 字公共子串即通过
  const segs = entry
    .split(/[，。！？、：；""''「」『』（）()!?,.:;~～…—\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .sort((a, b) => b.length - a.length);
  if (segs.length === 0) return true; // 纯短梗/纯数字：靠数字指纹兜底
  return segs.some((s) => hasCommonChunk(normTxt(s), rawNorm, 6));
}

// 乱码/数据串过滤：抓取来源里混入的 ID 串、战绩数据串（如"1715908手AGATVT…"）
// 特征是长条目里几乎没有中文。≥12 字符且中文字符少于 2 个 → 判为乱码，直接丢弃。
// （纯英文短梗如"Team Spirit"长度通常 <12 或出现在中文条目内，不受影响。）
const looksLikeGarbage = (s: string): boolean => {
  if (s.length < 12) return false;
  return (s.match(/[\u4e00-\u9fff]/g) || []).length < 2;
};

// 主线 2-gram：从条目文本里剔除主体名后取全部 2-gram（去空格/全角归一）。
// 用途：确定性丢弃"跑题素材"——比如主线是"只要我足够强就能留得住人"，
// 模型硬凑进来的"donk与女友在Steam互留留言""生于2007年1月25日"与主线 2-gram 零命中，直接杀；
// 与主线相关的条目（引用原话/围绕角度词展开）必然命中多个。宁空勿凑。
function angleGramsOf(topic: string, entity: string): Set<string> {
  let t = normTxt(topic);
  const e = normTxt(entity);
  if (e && t.includes(e)) t = t.split(e).join(" ");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

// 高频虚词 2-gram：这类组合（"只要""就是"等）是句式模板的骨架，本身不带主题信息。
// 网友拿原话句式玩梗（如主线"只要我足够强就能留得住人"→梗"只要我打不过就是挂"）时，
// 与主线共享的往往只有这些模板词；若计入命中，跑题条目会被误判为相关。统计时跳过。
const STOP_BIGRAMS = new Set([
  "只要", "要我", "我要", "就是", "不是", "没有", "可以", "如果",
  "但是", "可是", "这个", "那个", "什么", "怎么", "还是", "只是",
  "因为", "所以", "一个", "所有", "自己", "我们", "你们", "他们",
  "她们", "就能", "已经", "应该", "必须", "真的", "时候", "现在",
  "开始", "大家", "也是", "一下",
]);

// 事件进展类信号词：标题含这类词的热点有"发生→发展→结果"的时间脉络，不禁时间线
const EVENT_TOPIC_RE =
  /官宣|宣布|回应|否认|道歉|致歉|去世|逝世|夺冠|获奖|获得|揭晓|发布|上线|开播|开庭|判决|被捕|被拘|被罚|辞职|加盟|续约|退役|复出|晋级|淘汰|破纪录|上榜|开售|秒空|事故|地震|火灾|坠机|塌方|爆炸|起诉|调查|通报|遇难|失联|开业|签约|交手|对阵|赛程|直播中|崩了|瘫痪| outage/i;

// 语录/观点类热点识别：一句话/一个观点/一个梗，没有时间脉络，硬凑的"时间线"必然
// 变成主体生涯杂闻拼盘。命中后在 prompt 显式禁 timeline 并确定性置空。
// 刻意保守：只认强信号（显式类型词 / 引号占大半 / 主张句式开头），拿不准就不禁——
// 宁可少出时间线，也不误杀事件类热点的时间脉络。
function isQuoteStyleTopic(topic: string): boolean {
  const t = topic.trim();
  if (!t) return false;
  if (/语录|金句|名言|名场面|口头禅|玩梗|热梗|梗图/.test(t)) return true;
  if (EVENT_TOPIC_RE.test(t)) return false; // 有明确事件词 → 事件类，不禁
  // 引号内容占大半（≥60%）→ 语录型，如「只要我足够强，就能留得住人」
  const q = t.match(/[「“"']([^「」“”"']{6,})[」”"']/);
  if (q) {
    const bare = t.replace(/[「」“”"']/g, "").length;
    if (q[1].length >= bare * 0.6) return true;
  }
  // "主体：主张句"（如 donk：只要够强就能留住所有人）或主张句式开头的短条目
  const c = t.match(/^[^：:]{1,16}[：:]\s*(.+)$/);
  const rest = (c ? c[1] : t).trim();
  return rest.length <= 30 && /^(只要|要是|如果|没有|不是|就算|哪怕|哪有|谁说)/.test(rest);
}

type AttestedSets = {
  memes?: Set<string>;
  timeline?: Set<string>;
  facts?: Set<string>;
};

function validateMaterial(
  m: Material,
  raw: string,
  angleGrams: Set<string> = new Set(),
  attested: AttestedSets = {}
): Material {
  if (!m) return m;
  const rawNorm = normTxt(raw);
  // 主线锚定（字面兜底）：条目须与主线角度词有真实词汇重叠——总命中 ≥2 且其中 ≥1 个是
  // 非虚词命中（模板词命中不算，防"只要我X"式句型撞车）。grams 不足 3 个的短话题无法
  // 判别，跳过此判定退回原文指纹校验。
  // 与模型语义自证（attested：模型标注 on=1 的"与主线同一核心主题"条目）取【并集】——
  // "打的就是兄弟CS"之于"只要我足够强就能留住所有人"字面零重叠但同主题，靠自证放行；
  // 字面命中的条目即使模型漏标也保留。金句/时间线/事实统一适用。
  const onMainline = (x: string): boolean => {
    if (angleGrams.size < 3) return true;
    const e = normTxt(x);
    let total = 0;
    let content = 0;
    for (const g of angleGrams) {
      if (e.includes(g)) {
        total++;
        if (!STOP_BIGRAMS.has(g)) content++;
      }
    }
    return total >= 2 && content >= 1;
  };
  const keep = (arr: string[], ok?: Set<string>) =>
    arr.filter(
      (x) =>
        !looksLikeGarbage(x) &&
        checkTraces(x, rawNorm) &&
        ((ok && ok.has(normTxt(x))) || onMainline(x))
    );
  return {
    ...m,
    memes: keep(m.memes, attested.memes),
    timeline: keep(m.timeline, attested.timeline),
    facts: keep(m.facts, attested.facts),
  };
}

async function genMaterial(
  topic: string,
  platform: string,
  hits: SearchHit[],
  entity = ""
): Promise<Material> {
  if (!getLlm().apiKey) return null;
  // 资料每条带来源发布日期：模型据此给时间线写年份，校验也能核实条目里的年份
  const material = hits
    .slice(0, 8)
    .map(
      (h, i) =>
        `【来源${i + 1}｜${sourceOf(h.url)}${
          h.published ? `｜${String(h.published).slice(0, 10)}` : ""
        }】${h.title}｜${h.content}`.trim()
    )
    .filter((s) => s.length > 6)
    .join("\n");
  const hasMaterial = material.length > 0;
  // 覆盖度标记：有效资料（摘要有实质内容）不足 2 条时，素材卡降权提示
  const richCount = hits.filter((h) => (h.content || "").trim().length >= 30).length;
  const thin = richCount < 2;
  const from = platform ? `（来自${platform}热榜）` : "";
  // 主体条目：素材同样必须以主体本身为核心，金句/时间线/事实都要落在主体身上
  const entityRule = entity
    ? `\n- 素材必须【围绕主体「${entity}」本身】：oneLine 要说清「${entity}」和该角度的关系，memes/facts/timeline 里涉及具体事实时尽量写明是「${entity}」的（而非只说角度概念），角度（angles）也优先落到「${entity}」本身可做的内容上；`
    : "";
  // 语录/观点类热点（一句话/一个观点/一个梗）没有时间脉络：prompt 显式禁 timeline，
  // 解析后还会确定性置空，双保险防"主体生涯杂闻拼盘"式时间线
  const quoteStyle = isQuoteStyleTopic(topic);
  // 2026-09 修复 facts 为空：语录类热点此前把 facts 也限死在"这句原话及同主题"，
  // 资料里没有同主题硬数据时模型只能返回空数组。放开为"同主题 + 主体本人硬事实"，
  // 让素材卡先给创作者"主体是谁"的锚（年龄/队伍/代表成绩），观点卡不至整块空白。
  // timeline 仍禁置空（语录没有时间脉络，防生涯杂闻拼盘）。
  const quoteStyleNote = quoteStyle
    ? `\n- 特别说明：本条属于语录/观点类热点（没有时间脉络），timeline 必须是空数组；memes 只收这句原话以及与之同一核心主题（on=1）的内容；facts 收两类：①与这句原话同一核心主题的硬事实（on=1）②主体「${entity || "该主体"}」本人的硬事实 2-4 条（年龄/国籍/所属队伍/代表成绩等，on=1，让创作者先认识主体再听观点）；`
    : "";
  const prompt = hasMaterial
    ? `你是短视频口播选题助手。下面是关于热点「${topic}」${from}的多篇真实资料：\n${material}\n\n请帮口播创作者快速判断这条热点能怎么做，输出一个 JSON 对象：\n{\n  "oneLine": "用一句话（40字内）说清这条热点到底在讲什么，让创作者不点开链接也能秒懂",\n  "memes": [{"t": "热梗/金句原文片段", "on": 1}],\n  "angles": ["2-3个适合做口播的切入角度，每个一句话，例如 吐槽向/共情向/科普向/反转向/蹭热度向"],\n  "timeline": [{"t": "时间/阶段—发生了什么", "on": 1}],\n  "facts": [{"t": "硬数据或确定事实", "on": 1}]\n}\n硬性要求（与详细报道同一标准，宁缺毋滥）：\n- memes/timeline/facts 每个元素都是 {"t":"内容","on":0或1}。【on=1】=该条与主线是【同一核心主题】（同一主张/同一事件/同一叙事），即使措辞完全不同也算——例：主线是"只要我足够强就能留住所有人"，"打的就是兄弟CS"与之同讲"实力留人"，on=1；【on=0】=仅主体相同但讲别的事——感情/私人生活、旧荣誉盘点、装备参数、其他事件、拿句式玩梗嘲讽别的事。on=0 的条目程序会直接丢弃，宁可 on=0 也不要硬凑；\n- memes【只能】摘自上面资料原文里实际出现的原话/标题片段（可以截短），【严禁】自己创作、模仿网友口吻或改写资料里没有的表达——你写的每条金句都会被程序与原文比对，原文里找不到的会被直接丢弃；\n- timeline【只适合多时间点连续进展的事件】：必须同时满足三个条件才输出——a) 存在"发生了什么→后续发展→各方反应/结果"的连续脉络；b) 每条都能写出明确时间（格式"2026年9月10日—发生了什么"，或"近日/昨日/本周"开头），查不到日期的进展【不许】进 timeline，放进 facts；c) 够格的时间点至少 2 个，只有单点或静态介绍时 timeline 给空数组。金句/语录、观点态度、玩梗二创、榜单盘点、攻略科普、情绪共鸣、单一产品/人物百科类内容一律空数组，严禁拿生涯节点硬凑；只收【同一条事件线】上的节点，多年前的旧产品首发、旧赛事、别的事件即使主体相同也【严禁】混入今年的时间线；\n- 【时间线优先，事实只做补充、严禁重复】能梳理出时间脉络的事件，先把关键进展尽量完整地放进 timeline；facts 只放时间线【之外】仍对创作重要的补充信息（不随时间展开的硬数据/金额/年龄/身份背景/因果细节等）——凡与 timeline 某一条讲的是同一件事（哪怕措辞不同），一律【不得】再写进 facts；时间线之外没有重要补充时 facts 给空数组。没有时间脉络的热点 timeline 给空数组，事实才由 facts 承载；\n- facts/timeline 每条的数字、日期、专名必须与资料原文一致，多篇来源【一致确认】才写，各来源说法冲突的细节【直接略去】；\n- 时效基准：今天是 ${new Date().toISOString().slice(0, 10)}。facts/timeline 里涉及"现状"的条目以资料中【最新进展】为准（同一主体有"下放→回归→夺冠"这类多个时间点时，必须包含最新进展；只列旧状态而漏掉最新进展=不合格），旧事件可以保留但必须写成"曾/此前"的过去式背景；\n- 角度（angles）可以自由发挥，但不要基于资料里不存在的事实展开；
- 【事实零补充】oneLine、memes、angles 都不得引入资料外的任何具体事实：人名、人物关系、价格、费用、降幅、速度、票数、日期等数字与专名，资料原文没有的【一个字都不许补】；资料只说"更便宜/降价/按更低单价计费"而没给具体钱数时，绝不能自己编一个具体金额；memes 必须是资料原文里的片段，严禁把编造的事实混进金句；angles 只给创作方向和情绪切口，不陈述资料外的"事实"；${entityRule}${quoteStyleNote}\n- 只返回 JSON，不要任何解释或多余文字。`
    : `你是短视频口播选题助手。仅凭热点标题「${topic}」${from}（暂无更多检索资料），给口播创作者一点方向性建议，输出一个 JSON 对象：\n{\n  "oneLine": "用一句话推测这条热点大概在讲什么（40字内）",\n  "memes": [],\n  "angles": ["2-3个可能适合的口播切入角度，每个一句话"],\n  "timeline": [],\n  "facts": []\n}\n因为没有资料，memes 必须为空数组，不要编造具体的梗或事实；timeline 和 facts 也必须为空数组。只返回 JSON，不要任何解释。`;
  try {
    const llm = getLlm();
    // 同 genReport：Key/欠费类错误冒泡到顶层 catch 给引导，不吞成 null
    const json = await llmChatJson(
      llm,
      { messages: [{ role: "user", content: prompt }] },
      60000
    );
    const txt: string = json.choices?.[0]?.message?.content || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const toStrArr = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
    // {t,on} 条目解析：容忍模型退回纯字符串（此时无自证，交给字面校验判定）
    const toItems = (
      v: unknown,
      max: number
    ): { texts: string[]; attested: Set<string> } => {
      const texts: string[] = [];
      const attested = new Set<string>();
      if (Array.isArray(v)) {
        for (const x of v) {
          if (typeof x === "string") {
            const s = x.trim();
            if (s) texts.push(s);
          } else if (x && typeof x === "object") {
            const o = x as Record<string, unknown>;
            const t = typeof o.t === "string" ? o.t.trim() : "";
            if (!t) continue;
            texts.push(t);
            if (o.on === 1 || o.on === true) attested.add(normTxt(t));
          }
          if (texts.length >= max) break;
        }
      }
      return { texts, attested };
    };
    const oneLine =
      typeof obj.oneLine === "string" ? obj.oneLine.trim() : "";
    const memeItems = toItems(obj.memes, 5);
    const timelineItems = toItems(obj.timeline, 8);
    const factItems = toItems(obj.facts, 6);
    const angles = toStrArr(obj.angles);
    const memes = memeItems.texts;
    // 语录/观点类热点没有时间脉络：确定性置空；其余走时间线结构过滤
    // （每条必须有时间锚、年份窗口、不足 2 点整条取消——见 filterTimeline）
    const timeline = isQuoteStyleTopic(topic)
      ? []
      : filterTimeline(timelineItems.texts, topic, hits);
    let facts = factItems.texts;
    // 语录/观点类热点：facts 里的主体本人硬事实（年龄/队伍/成绩）与主张句主线字面
    // 零重叠，会被主线锚定门误杀（prompt 已放开让模型收这类条目）。凡提到主体名的
    // fact 等效为模型语义自证（on=1），放行主线门；checkTraces 原文比对仍在，
    // 编造的"主体事实"照样被拦。
    if (quoteStyle && entity) {
      const en = entity.toLowerCase();
      for (const t of facts) {
        if (t.toLowerCase().includes(en)) factItems.attested.add(normTxt(t));
      }
    }
    // 事件类热点：事实块只保留时间线之外的补充信息，与时间线重复的条目确定性剔除
    if (!quoteStyle && timeline.length > 0) {
      facts = facts.filter((f) => !factCoveredByTimeline(f, timeline));
    }
    if (
      !oneLine &&
      memes.length === 0 &&
      angles.length === 0 &&
      timeline.length === 0 &&
      facts.length === 0
    )
      return null;
    // 确定性后校验：memes/timeline/facts 逐条与检索原文比对，编造条目直接丢弃；
    // 主线锚定 = 模型语义自证（on=1）∪ 字面 2-gram 兜底，语义同题但措辞不同的条目可放行。
    const angleGrams = angleGramsOf(topic, entity);
    const checked = validateMaterial(
      { oneLine, memes, angles, timeline, facts },
      material,
      angleGrams,
      {
        memes: memeItems.attested,
        timeline: timelineItems.attested,
        facts: factItems.attested,
      }
    );
    if (!checked) return null;
    // validateMaterial 可能再杀掉部分时间线条目；存活不足 2 条同样整条取消
    if (Array.isArray(checked.timeline) && checked.timeline.length === 1)
      checked.timeline = [];
    if (
      !checked.oneLine &&
      (checked.memes?.length ?? 0) === 0 &&
      (checked.angles?.length ?? 0) === 0 &&
      (checked.timeline?.length ?? 0) === 0 &&
      (checked.facts?.length ?? 0) === 0
    )
      return null;
    return { ...checked, thin };
  } catch (e) {
    // Key/欠费类错误冒泡给顶层引导；JSON 解析失败等模型抖动按无素材降级
    if (e instanceof LlmApiError) throw e;
    return null;
  }
}
