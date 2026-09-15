"use client";

import { useState, useRef, useEffect, Fragment, Children } from "react";
import {
  LLM_PROVIDERS,
  getProviderPreset,
  type LlmErrorAction,
  type LlmOverride,
} from "../lib/llm-providers";
import { extractEntityFromOverview } from "../lib/relevance";
import {
  heuristicAngleKeywords,
  parseAngleMarker,
  stripAngleLead,
} from "../lib/angleItem";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolLogs?: string[];
  emptyNote?: string;
  domains?: string[]; // 服务端判定的本轮实际生效领域（抓热点时回填到气泡；普通聊天无）
  kind?: "script"; // 生成脚本产出的消息：按纯文本渲染，不当作热点条目解析出「查看详情」
  failed?: boolean; // 请求超时/网络失败：居中提示卡 + 重试按钮，不按普通回答气泡渲染
  // 「重试后仍失败」的反馈戳：每次重试失败 +1；卡片 key 带它强制重挂载，
  // 保证红色抖动动画【每次】都能重播（布尔 class 在同节点增删时浏览器可能不重播动画）
  flashNonce?: number;
  llmError?: LlmErrorAction | null; // LLM 配置类失败（无Key/Key无效/欠费/限流）：卡片渲染配置/充值直达按钮
  // 服务端盖的"本轮结构邮戳"（hotboard=热榜轮 / overview=主体速览轮 / other=普通轮）；
  // 下一条请求原样带回给后端做意图路由，替代后端从回复正文里正则猜上一轮类型
  turnType?: "hotboard" | "overview" | "other";
  // 本轮全网搜索参考来源（2026-09 起由服务端 refs 字段结构化下发）：
  // 第一层回复下默认折叠的"参考网站/参考视频"，随消息一起持久化、历史消息可回看
  refs?: { sites: RefSite[]; videos: RefSite[] };
}

interface DetailData {
  report: string;
  profile?: string; // 基本资料（主体条目才有）：这条切入所讲事件本身的基本盘（什么事/涉及谁/时间结果）
  // 事实门未放行时为 true：report 只是"没查到"的提示语，禁止拿它直接生成脚本
  needClarify?: boolean;
  sites: { title: string; url: string; source?: string; core?: boolean; search?: boolean; date?: string; snippet?: string }[];
  videos: { title: string; url: string; app?: string; source?: string; core?: boolean; search?: boolean; date?: string }[];
  material?: { oneLine?: string; memes?: string[]; angles?: string[]; timeline?: string[]; facts?: string[]; thin?: boolean } | null;
  llmError?: LlmErrorAction | null; // LLM 配置类失败：详情面板渲染配置/充值直达按钮
}

// 一稿多发：单平台成稿包（标题候选 / 封面文案 / 正文 / 话题标签）
type MultiPackItem = {
  titles: string[];
  cover: string;
  body: string;
  tags: string[];
};
type MultiPack = { xhs?: MultiPackItem | null; gzh?: MultiPackItem | null };

interface DetailState {
  open: boolean;
  loading: boolean;
  data: DetailData | null;
  error?: boolean;
}

interface Session {
  id: string;
  title: string;
  messages: Message[];
}

// 搜索引擎跳转链（chinaso/360/搜狗/百度/bing 重定向包装）与各平台站内搜索页
// （百度/s?、知乎/search、B站/search.bilibili、小红书/search_result、微博/s.weibo、抖音/search）——
// 都不是文章/视频原链，参考列表里这类条目前面挂「去搜索」小标签，提示这是检索入口而非直接来源。
// ⚠️ 主机规则必须带 `//` + 显式子域边界：百家号文章页是 baijiahao.baidu.com/s?id=…，
// 路径恰好含 "baidu.com/s?" 子串，不卡边界会被误判成"百度搜索入口"（与后端 detail 路由
// L198 的排除保护同一教训）。
const INDIRECT_URL_RE =
  /\/\/(?:www\.)?chinaso\.com\/link|\/\/(?:www\.)?so\.com\/link|\/\/(?:www\.)?sogou\.com\/link|\/\/(?:www|m)\.baidu\.com\/link|\/\/(?:www|cn\.)?bing\.com\/ck|google\.[a-z.]+\/url\?|\/\/(?:www|m)\.baidu\.com\/s\?|\/\/(?:www\.)?zhihu\.com\/search|\/\/(?:www\.)?bilibili\.com\/search|\/\/(?:www\.)?xiaohongshu\.com\/search_result|\/\/s\.weibo\.com|\/\/(?:www|so|m)\.douyin\.com\/search/;
const isIndirectRef = (u: string) => INDIRECT_URL_RE.test(u || "");

// 「去搜索」小标签：放大镜 icon + 文字，随条目链接一起可点
const SearchTag = () => (
  <span className="mr-1 inline-flex items-center gap-0.5 align-baseline rounded-full bg-indigo-50 px-1.5 py-px text-[10px] font-medium text-indigo-400 whitespace-nowrap">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="h-2.5 w-2.5"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
    去搜索
  </span>
);

// ============ 参考来源折叠块（2026-09 同题评测后新增）============
// 单主题详情报告的参考网站较多（10-16 个），平铺会把报道正文挤到看不见。
// 收进折叠块：收起时只显示图标行 + 数量，点击展开完整列表。
// 只用于 detail 单主题面板；抓热点消息的多条结果不套用（每条都挂一块折叠会喧宾夺主）。

// 域名首字符彩色圆 icon：按域名 hash 从固定色板取色（无外链 favicon 依赖，
// 中国区可用性稳定；同域名颜色恒定，方便用户跨条目识别同一站点）
const SITE_ICON_COLORS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#3b82f6",
];
const SiteIcon = ({ url }: { url: string }) => {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").replace(/^m\./, "");
  } catch {
    /* 非法 URL 显示占位字符 */
  }
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
      style={{ background: SITE_ICON_COLORS[h % SITE_ICON_COLORS.length] }}
    >
      {(host[0] || "?").toUpperCase()}
    </span>
  );
};

type RefSite = {
  url: string;
  title: string;
  source?: string;
  date?: string;
  core?: boolean;
  search?: boolean;
  app?: string; // 视频类条目指定的 App 唤起 scheme（抖音等）
};
// 视频链接判定（与后端 chat/route.ts VIDEO_REF_RE、detail isVideoUrl 同口径）
const VIDEO_URL_RE =
  /bilibili\.com\/video|b23\.tv|youtube\.com\/watch|youtu\.be|douyin\.com|v\.douyin\.com|kuaishou\.com|v\.qq\.com|ixigua\.com/;
// 聊天自主产出（0 命中近30天兜底 / 今日仅1-2条补挂）正文末尾的机器可读参考网站标记：
// 服务端拼成单行 %%REFS%%[{t,u,s,d}]，前端解析后渲染成折叠参考块，不把标记原样显示给用户。
const REFS_PREFIX = "%%REFS%%";
// 折叠壳：参考网站/参考视频共用——标题行（图标+名称+数量+箭头）点击切换。
// defaultOpen 决定初始形态；preview=N 时展开态默认只露前 N 条，标题右侧出
// 「展开更多（共X条）」，点了才展示全部，避免十几条链接全摊开太吵。
const RefCollapsible = ({
  icon,
  label,
  count,
  defaultOpen = false,
  preview,
  children,
}: {
  icon: string;
  label: string;
  count: number;
  defaultOpen?: boolean;
  preview?: number; // 展开态先露几条；不传 = 展开即全部
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen || typeof preview === "number");
  const [allShown, setAllShown] = useState(false);
  const hasPreview = typeof preview === "number" && preview > 0;
  const hasMore = hasPreview && count > (preview as number);
  const body =
    open && hasPreview && hasMore && !allShown
      ? Children.toArray(children).slice(0, preview as number)
      : children;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-1.5 font-semibold text-gray-700"
        >
          <span>{icon}</span> {label}（{count}）
          <span
            className={`text-[10px] text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {open && hasMore && (
          <button
            type="button"
            onClick={() => setAllShown((v) => !v)}
            className="ml-auto cursor-pointer text-[11px] font-normal text-indigo-500 hover:underline shrink-0"
          >
            {allShown ? "收起" : `展开更多（共${count}条）`}
          </button>
        )}
      </div>
      {open && <div className="mt-1 flex flex-col gap-1">{body}</div>}
    </div>
  );
};

// 单条参考链接的公共尾部：核心来源胶囊 + 来源/日期
const RefMeta = ({ s }: { s: RefSite }) => (
  <>
    {s.core && (
      <span className="ml-1 align-middle text-[10px] px-1 py-px rounded bg-emerald-100 text-emerald-600">
        核心来源
      </span>
    )}
    {(s.source || s.date) && (
      <span className="ml-1 text-xs text-gray-400">
        {s.source ? `— ${s.source}` : ""}
        {s.source && s.date ? " · " : ""}
        {s.date || ""}
      </span>
    )}
  </>
);

const RefSitesBlock = ({
  sites,
  onOpenApp,
  defaultOpen = false,
  preview,
}: {
  sites: RefSite[];
  onOpenApp: (url: string) => void;
  defaultOpen?: boolean; // 详情面板默认直接展开；聊天消息里的参考块默认折叠
  preview?: number; // 展开态默认只露前几条，右侧「展开更多」看全部
}) => {
  return (
    <RefCollapsible
      icon="🔗"
      label="参考网站"
      count={sites.length}
      defaultOpen={defaultOpen}
      preview={preview}
    >
      {sites.map((s, k) => (
        <a
          key={k}
          href={s.url}
          target="_blank"
          rel="noreferrer"
          onClick={
            resolveAppFallback(s.url)
              ? (e) => {
                  e.preventDefault();
                  onOpenApp(s.url);
                }
              : undefined
          }
          className="flex items-baseline break-words text-indigo-500 hover:underline"
        >
          <SiteIcon url={s.url} />
          <span>
            {(s.search || isIndirectRef(s.url)) && <SearchTag />}
            {s.title}
            <RefMeta s={s} />
          </span>
        </a>
      ))}
    </RefCollapsible>
  );
};

// 参考视频折叠块：与参考网站同构，链接点击走视频 App 唤起链（app scheme 优先）
const RefVideosBlock = ({
  videos,
  onOpenApp,
  defaultOpen = false,
  preview,
}: {
  videos: RefSite[];
  onOpenApp: (url: string, app?: string) => void;
  defaultOpen?: boolean;
  preview?: number;
}) => {
  return (
    <RefCollapsible
      icon="🎬"
      label="参考视频"
      count={videos.length}
      defaultOpen={defaultOpen}
      preview={preview}
    >
      {videos.map((v, k) => (
        <a
          key={k}
          href={v.url}
          target="_blank"
          rel="noreferrer"
          onClick={
            v.app || resolveAppFallback(v.url)
              ? (e) => {
                  e.preventDefault();
                  onOpenApp(v.url, v.app);
                }
              : undefined
          }
          className="text-indigo-500 hover:underline break-words"
        >
          {(v.search || isIndirectRef(v.url)) && <SearchTag />}
          {v.title}
          <RefMeta s={v} />
        </a>
      ))}
    </RefCollapsible>
  );
};

// ============ 移动端平台搜索链接降级链（App scheme → 移动网页版 → 下载页）============
// 「去搜索」类链接（"抖音搜索：xxx"等）在手机上直接开网页版经常撞登录墙/半残页面。
// 点击时先试 App scheme（唤起对应 App）；约 1.4s 页面仍可见（没装/唤起失败）就退到
// 移动版网页；网页也走不通再退下载页。桌面端不受影响，一律开新标签。
// scheme 落不了的唯一代价是多等 1.4s，绝不会比原来差。
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
interface AppFallback {
  appName: string; // App 显示名（操作表/引导文案用）
  match: RegExp; // 第1捕获组 = 关键词（保持编码原样）
  // 按系统返回有序的 scheme 候选（iOS/Android 协议前缀可能不同）：
  // 点击时先试第 1 个；失败后操作表里可再点，必要时还能换第 2 个。
  schemes: (key: string, isIOS: boolean) => string[];
  web?: (url: string) => string; // 移动端更友好的网页版地址（缺省 = 原链接）
  dlIOS?: string; // iOS 下载页（App Store）
  dlAd?: string; // Android 下载页（应用宝详情页）
}
const XHS_IOS_ID = "976916313";
const XHS_ANDROID_PKG = "com.xingin.xhs";
const xhsKw = (k: string) => encodeURIComponent(k);
const APP_FALLBACKS: AppFallback[] = [
  // —— 内容原链（2026-09 手机端补丁）——
  // 搜索结果里的抖音/小红书内容页（douyin.com/video/xxx、xiaohongshu.com/explore/xxx）
  // 在手机上直接开是登录墙/荒芜页——之前降级链只覆盖「去搜索」搜索页，这就是
  // "点开是荒芜页"的根因。补上内容页规则：先唤起 App 看原内容；没装 App 退到
  // 免登录的移动分享页；再不行送下载页。桌面端仍直接开原链，不受影响。
  {
    appName: "抖音",
    match: /douyin\.com\/(?:video|note)\/(\d+)/,
    schemes: (k) => [`snssdk1128://aweme/detail/${k}`],
    // iesdouyin 分享页是抖音唯一免登录渲染内容的移动网页端（note=图文）
    web: (u) => {
      const k = /douyin\.com\/(?:video|note)\/(\d+)/.exec(u)?.[1] || "";
      return `https://www.iesdouyin.com/share/${
        /douyin\.com\/note\//.test(u) ? "note" : "video"
      }/${k}`;
    },
    dlIOS: "https://apps.apple.com/cn/app/id1142110895",
    dlAd: "https://sj.qq.com/appdetail/com.ss.android.ugc.aweme",
  },
  {
    appName: "小红书",
    match: /xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-fA-F]{24})/,
    // iOS 笔记页协议 xhsdiscover://item/<id>；安卓文档为 xhsdiscovery://note?noteId=<id>
    // （CSDN 真机清单），但 AutoJs 社区也有安卓走 xhsdiscover://item 的样本——两个都给，
    // 主协议失败后操作表里还可点备选。
    schemes: (k, isIOS) =>
      isIOS
        ? [`xhsdiscover://item/${k}?type=normal`, `xhsdiscovery://note?noteId=${k}`]
        : [`xhsdiscovery://note?noteId=${k}`, `xhsdiscover://item/${k}`],
    // 小红书移动网页版至少能渲染笔记本体（带登录浮层），比桌面版荒芜页强
    web: (u) => {
      const k =
        /xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-fA-F]{24})/.exec(
          u
        )?.[1] || "";
      return `https://www.xiaohongshu.com/explore/${k}`;
    },
    dlIOS: `https://apps.apple.com/cn/app/id${XHS_IOS_ID}`,
    dlAd: `https://sj.qq.com/appdetail/${XHS_ANDROID_PKG}`,
  },
  {
    appName: "微博",
    // 微博正文页（2026-09 手机端补丁）：桌面版 weibo.com/{uid}/{bid} 在手机上是
    // 荒芜页/引导下载页。转 m.weibo.cn/status/{bid} 移动版正文（bid 通用）；
    // 先试 sinaweibo:// 唤起 App，再退移动版，最后送下载页。
    match: /weibo\.com\/\d+\/([0-9A-Za-z]+)/,
    schemes: (k) => [`sinaweibo://detail?mid=${k}`],
    web: (u) => {
      const k = /weibo\.com\/\d+\/([0-9A-Za-z]+)/.exec(u)?.[1] || "";
      return `https://m.weibo.cn/status/${k}`;
    },
    dlIOS: "https://apps.apple.com/cn/app/id350962114",
    dlAd: "https://sj.qq.com/appdetail/com.sina.weibo",
  },
  {
    appName: "抖音",
    match: /douyin\.com\/search\/([^/?#]+)/,
    schemes: (k) => [`snssdk1128://search?keyword=${xhsKw(k)}`],
    // 抖音网页版登录墙最硬，网页仍保留搜索页但优先唤起/下载
    web: (u) => u,
    dlIOS: "https://apps.apple.com/cn/app/id1142110895",
    dlAd: "https://sj.qq.com/appdetail/com.ss.android.ugc.aweme",
  },
  {
    appName: "微博",
    match: /s\.weibo\.com\/weibo\?[^#]*?q=([^&#]+)/,
    schemes: (k) => [`sinaweibo://searchall?q=${encodeURIComponent(k)}`],
    // s.weibo.com 手机上体验差，退到 m.weibo.cn 的综合搜索容器
    web: (u) => {
      const k = safeDecodeURIComponent(/q=([^&#]+)/.exec(u)?.[1] || "");
      return `https://m.weibo.cn/search?containerid=${encodeURIComponent(
        `100103type=1&q=${k}`
      )}`;
    },
    dlIOS: "https://apps.apple.com/cn/app/id350962114",
    dlAd: "https://sj.qq.com/appdetail/com.sina.weibo",
  },
  {
    appName: "知乎",
    match: /zhihu\.com\/search\?[^#]*?q=([^&#]+)/,
    schemes: (k) => [`zhihu://search?q=${encodeURIComponent(k)}`],
    web: (u) => u,
    dlAd: "https://sj.qq.com/appdetail/com.zhihu.android",
  },
  {
    appName: "哔哩哔哩",
    match: /(?:search\.)?bilibili\.com\/(?:all|search)[^#]*?keyword=([^&#]+)/,
    schemes: (k) => [`bilibili://search?keyword=${encodeURIComponent(k)}`],
    web: (u) => u,
    dlAd: "https://sj.qq.com/appdetail/tv.danmaku.bili",
  },
  {
    appName: "小红书",
    match: /xiaohongshu\.com\/search_result\?[^#]*?keyword=([^&#]+)/,
    // 小红书 App 搜索 scheme（2026-09 三次修正）：CSDN《URL Scheme 最全指南
    // （2025-06 真机实测、持续更新）》与 cnblogs AutoJs 清单一致记录：
    //   iOS：xhsdiscover://search/result?keyword=xxx（也兼容 search?keyword=）
    //   安卓：发现协议前缀是 xhsdiscovery://（与 iOS 的 xhsdiscover 不同），
    //         AutoJs 安卓样本同样用 xhsdiscover://search/result——两个都给。
    // 点链接先试主协议；没唤起则弹操作表，表里是真正的 <a href=scheme>（用户
    // 手势点击比 JS 跳转更可靠，能过部分浏览器的拦截），并提供备选协议/下载。
    // 网页降级加 source=web_explore_feed（比裸链渲染略好，仍有登录浮层）。
    schemes: (k, isIOS) => {
      const kw = xhsKw(k);
      return isIOS
        ? [
            `xhsdiscover://search/result?keyword=${kw}`,
            `xhsdiscover://search?keyword=${kw}`,
            `xhsdiscovery://search/result?keyword=${kw}`,
          ]
        : [
            `xhsdiscovery://search/result?keyword=${kw}`,
            `xhsdiscover://search/result?keyword=${kw}`,
          ];
    },
    web: (u) => {
      const k = safeDecodeURIComponent(/keyword=([^&#]+)/.exec(u)?.[1] || "");
      return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(k)}&source=web_explore_feed`;
    },
    dlIOS: `https://apps.apple.com/cn/app/id${XHS_IOS_ID}`,
    dlAd: `https://sj.qq.com/appdetail/${XHS_ANDROID_PKG}`,
  },
];
function resolveAppFallback(url: string): { fb: AppFallback; key: string } | null {
  for (const fb of APP_FALLBACKS) {
    const m = fb.match.exec(url);
    if (m) return { fb, key: safeDecodeURIComponent(m[1]) };
  }
  return null;
}

const WELCOME: Message = {
  role: "assistant",
  content: `欢迎使用热点抓取 Agent！已默认选中 8 个常用平台（微博、抖音、快手、小红书、百度、头条、B站、知乎），点击「抓取平台」可自行增删（最多 8 个）。\n\n你可以对我说：\n- "帮我抓取今日热点"\n- "根据XX领域筛选热点"\n- "帮我生成视频脚本"`,
};

const DEFAULT_SESSION_ID = "default";
const genId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const newSession = (): Session => ({
  id: genId(),
  title: "新会话",
  messages: [WELCOME],
});

// 同步码：hot-xxxx-xxxx-xxxx，去掉易混字符（0/o/1/l 等）
const genSyncCode = () => {
  const alpha = "abcdefghijkmnpqrstuvwxyz23456789";
  const seg = (n: number) =>
    Array.from(
      { length: n },
      () => alpha[Math.floor(Math.random() * alpha.length)]
    ).join("");
  return `hot-${seg(4)}-${seg(4)}-${seg(4)}`;
};

// 可选抓取平台：与后端 PLATFORM_FETCHERS 一致（2026-09-10 hotboard 板块接入后共 33 个）。
// 前 8 个 = 默认选中集合，顺序即产品指定的默认顺序；其余平台按大类排在后面。
const PLATFORMS = [
  "微博", "抖音", "快手", "小红书", "百度", "头条", "B站", "知乎",
  "什么值得买", "36氪", "虎扑", "财联社", "华尔街见闻", "澎湃",
  "IT之家", "掘金", "少数派", "虎嗅", "爱范儿", "极客公园", "果壳",
  "新浪", "新浪新闻", "AcFun", "CSDN", "HelloGitHub",
  "微信读书", "数字尾巴", "NGA", "米游社", "英雄联盟",
  "天气预警", "地震速报",
];
// 默认选中的平台（弹窗「重置」也恢复到这份清单）
const DEFAULT_PLATFORMS = ["微博", "抖音", "快手", "小红书", "百度", "头条", "B站", "知乎"];
// 平台最多同时选中的数量
const MAX_PLATFORMS = 8;

// 定时任务日期/时间的滚轮选择器：单框显示完整值，点击弹出 年/月/日（或 时/分）滚轮，
// 滚轮可上下滚动、月/日循环、中心行高亮，确定/取消写回。替代原生 date/time 输入框。
const pad2 = (n: number) => String(n).padStart(2, "0");
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => pad2(i));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => pad2(i));
// 字段触发框：整框可点、深色数字
const FIELD_CLS =
  "border rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white hover:border-indigo-300 transition text-left focus:outline-none focus:ring-2 focus:ring-indigo-400";
const SELECT_CLS =
  "border rounded-lg px-2 py-1 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400";

// 单列滚轮：scroll-snap 自动吸附整行；loop 模式选项复制三份、越过边缘无感重置实现循环
const ITEM_H = 36;
function WheelColumn({
  items,
  value,
  onChange,
  loop,
  width,
}: {
  items: string[];
  value: number;
  onChange: (i: number) => void;
  loop?: boolean;
  width?: number | string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = items.length;
  // 非循环列首尾各垫一个等高空白行：否则第一项滚不到中心选中带（滚动位置最小为 0，
  // 第一项只能停在顶部），实测表现就是年份列选不到当前年（2026 永远停在最上面一格，
  // 能落进选中带的最靠前一项变成 2027）。null = 占位空白行。
  const rendered: (string | null)[] = loop
    ? [...items, ...items, ...items]
    : [null, ...items, null];
  // value 变化 → 滚动定位（滚动中上报的 value 与当前位置一致，自动跳过，不干扰滚动）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = loop ? n : 0;
    const target = (base + value) * ITEM_H;
    if (Math.round(el.scrollTop) !== target) el.scrollTop = target;
  }, [value, loop, n]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const raw = Math.round(el.scrollTop / ITEM_H);
    if (loop) {
      if (raw < n) {
        el.scrollTop = (raw + n) * ITEM_H;
        return;
      }
      if (raw >= n * 2) {
        el.scrollTop = (raw - n) * ITEM_H;
        return;
      }
      const idx = raw - n;
      if (idx !== value) onChange(idx);
    } else if (raw !== value) {
      onChange(Math.max(0, Math.min(n - 1, raw)));
    }
  };
  return (
    <div className="relative" style={{ width: width || 64 }}>
      {/* 中心高亮带：最底层背景，文字压在其上 */}
      <div className="pointer-events-none absolute inset-x-1 top-1/2 z-0 -translate-y-1/2 h-9 rounded-md bg-indigo-100" />
      <div
        ref={ref}
        onScroll={onScroll}
        className="no-scrollbar relative z-10 h-[108px] overflow-y-scroll snap-y snap-mandatory"
      >
        {rendered.map((label, i) =>
          label === null ? (
            <div key={i} className="h-9 shrink-0" />
          ) : (
            <div
              key={i}
              className={`flex h-9 snap-center items-center justify-center text-sm transition-colors ${
                // 非循环列前面有一个占位行，高亮下标整体 +1
                i === (loop ? n + value : value + 1)
                  ? "font-medium text-gray-900"
                  : "text-gray-400"
              }`}
            >
              {label}
            </div>
          )
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-9 bg-gradient-to-b from-white to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-9 bg-gradient-to-t from-white to-transparent" />
    </div>
  );
}

// 滚轮弹层外壳：fixed 定位在触发框下方，点遮罩关闭，底部确定/取消
function WheelPopoverShell({
  pos,
  onConfirm,
  onClose,
  children,
}: {
  pos: { top: number; left: number };
  onConfirm: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        className="fixed z-[61] w-auto rounded-xl border border-gray-200 bg-white p-2 shadow-xl"
        style={{
          top: pos.top,
          left: pos.left,
        }}
      >
        {children}
        <div className="mt-1 flex items-center justify-end gap-3 border-t border-gray-100 px-1 pt-1.5">
          <button
            onClick={onClose}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700"
          >
            确定
          </button>
        </div>
      </div>
    </>
  );
}

// 年/月/日 三列滚轮。value="YYYY-MM-DD"；结束日期允许空（三栏从今天起跳），确定时写入
function DateWheelBody({
  value,
  minDate,
  pos,
  onConfirm,
  onClose,
}: {
  value: string;
  minDate?: string;
  pos: { top: number; left: number };
  onConfirm: (v: string) => void;
  onClose: () => void;
}) {
  const now = new Date();
  const [y, setY] = useState(() =>
    value ? Number(value.split("-")[0]) : now.getFullYear()
  );
  const [m, setM] = useState(() =>
    value ? Number(value.split("-")[1]) : now.getMonth() + 1
  );
  const [d, setD] = useState(() =>
    value ? Number(value.split("-")[2]) : now.getDate()
  );
  const ty = now.getFullYear();
  const dim = new Date(y, m, 0).getDate(); // 该月天数
  const dayEff = Math.min(d, dim);
  const years = Array.from({ length: 51 }, (_, i) => ty + i);
  const confirm = () => {
    let v = `${y}-${pad2(m)}-${pad2(dayEff)}`;
    if (minDate && v < minDate) v = minDate; // 结束日期不得早于开始日期
    onConfirm(v);
  };
  return (
    <WheelPopoverShell pos={pos} onConfirm={confirm} onClose={onClose}>
      <div className="flex items-center gap-1 px-1 py-1">
        <WheelColumn
          items={years.map((yy) => `${yy}年`)}
          value={Math.max(0, y - ty)}
          onChange={(i) => setY(ty + i)}
          width={72}
        />
        <WheelColumn
          items={Array.from({ length: 12 }, (_, i) => `${pad2(i + 1)}月`)}
          value={m - 1}
          loop
          onChange={(i) => {
            setM(i + 1);
            const ndim = new Date(y, i + 1, 0).getDate();
            if (d > ndim) setD(ndim); // 1/31 翻到 2 月自动变 28
          }}
          width={58}
        />
        <WheelColumn
          items={Array.from({ length: dim }, (_, i) => `${pad2(i + 1)}日`)}
          value={dayEff - 1}
          loop
          onChange={(i) => setD(i + 1)}
          width={58}
        />
      </div>
    </WheelPopoverShell>
  );
}

// 时/分 两列滚轮。value="HH:MM"
function TimeWheelBody({
  value,
  pos,
  onConfirm,
  onClose,
}: {
  value: string;
  pos: { top: number; left: number };
  onConfirm: (v: string) => void;
  onClose: () => void;
}) {
  const [hh, mm] = value.split(":");
  const [h, setH] = useState(Number(hh) || 0);
  const [m, setM] = useState(Number(mm) || 0);
  const confirm = () => onConfirm(`${pad2(h)}:${pad2(m)}`);
  return (
    <WheelPopoverShell pos={pos} onConfirm={confirm} onClose={onClose}>
      <div className="flex items-center gap-1 px-1 py-1">
        <WheelColumn
          items={HOUR_OPTIONS.map((x) => `${x}时`)}
          value={h}
          loop
          onChange={setH}
          width={58}
        />
        <WheelColumn
          items={MINUTE_OPTIONS.map((x) => `${x}分`)}
          value={m}
          loop
          onChange={setM}
          width={58}
        />
      </div>
    </WheelPopoverShell>
  );
}
// 平台专属配色：激活态 = 品牌色实心；未激活 hover 时向品牌色靠拢
const PLATFORM_COLORS: Record<string, { hover: string; dot: string }> = {
  微博: {
    hover: "hover:border-red-500 hover:text-red-600",
    dot: "bg-red-500",
  },
  知乎: {
    hover: "hover:border-sky-500 hover:text-sky-600",
    dot: "bg-sky-500",
  },
  "B站": {
    hover: "hover:border-pink-500 hover:text-pink-600",
    dot: "bg-pink-500",
  },
  抖音: {
    hover: "hover:border-slate-500 hover:text-slate-700",
    dot: "bg-slate-800",
  },
  小红书: {
    hover: "hover:border-rose-500 hover:text-rose-600",
    dot: "bg-rose-500",
  },
  头条: {
    hover: "hover:border-orange-500 hover:text-orange-600",
    dot: "bg-orange-500",
  },
  百度: {
    hover: "hover:border-blue-500 hover:text-blue-600",
    dot: "bg-blue-500",
  },
  什么值得买: {
    hover: "hover:border-amber-500 hover:text-amber-600",
    dot: "bg-amber-500",
  },
  "36氪": {
    hover: "hover:border-indigo-500 hover:text-indigo-600",
    dot: "bg-indigo-500",
  },
  虎扑: {
    hover: "hover:border-green-600 hover:text-green-700",
    dot: "bg-green-600",
  },
  快手: {
    hover: "hover:border-orange-500 hover:text-orange-600",
    dot: "bg-orange-500",
  },
  财联社: {
    hover: "hover:border-red-600 hover:text-red-700",
    dot: "bg-red-600",
  },
  华尔街见闻: {
    hover: "hover:border-amber-600 hover:text-amber-700",
    dot: "bg-amber-600",
  },
  澎湃: {
    hover: "hover:border-red-500 hover:text-red-600",
    dot: "bg-red-500",
  },
  "IT之家": {
    hover: "hover:border-rose-500 hover:text-rose-600",
    dot: "bg-rose-500",
  },
  掘金: {
    hover: "hover:border-blue-500 hover:text-blue-600",
    dot: "bg-blue-500",
  },
  少数派: {
    hover: "hover:border-indigo-500 hover:text-indigo-600",
    dot: "bg-indigo-500",
  },
  虎嗅: {
    hover: "hover:border-sky-600 hover:text-sky-700",
    dot: "bg-sky-600",
  },
  爱范儿: {
    hover: "hover:border-violet-500 hover:text-violet-600",
    dot: "bg-violet-500",
  },
  极客公园: {
    hover: "hover:border-cyan-600 hover:text-cyan-700",
    dot: "bg-cyan-600",
  },
  果壳: {
    hover: "hover:border-green-500 hover:text-green-600",
    dot: "bg-green-500",
  },
  新浪: {
    hover: "hover:border-red-500 hover:text-red-600",
    dot: "bg-red-500",
  },
  新浪新闻: {
    hover: "hover:border-red-500 hover:text-red-600",
    dot: "bg-red-500",
  },
  AcFun: {
    hover: "hover:border-blue-600 hover:text-blue-700",
    dot: "bg-blue-600",
  },
  NGA: {
    hover: "hover:border-orange-600 hover:text-orange-700",
    dot: "bg-orange-600",
  },
  米游社: {
    hover: "hover:border-sky-500 hover:text-sky-600",
    dot: "bg-sky-500",
  },
  英雄联盟: {
    hover: "hover:border-indigo-600 hover:text-indigo-700",
    dot: "bg-indigo-600",
  },
};
const DOMAINS = ["情感两性", "职场成长", "财经理财", "健康养生", "育儿教育", "社会热点", "历史文化", "影视娱乐", "科技互联网", "法制普法"];
// 旧版默认分类：仅用于迁移已持久化在 localStorage 里的领域列表——把不在新默认集里的旧默认项
// 剔除、换成新默认项，同时保留用户自建领域。让"改默认分类"对老用户也即时生效。
const LEGACY_DEFAULT_DOMAINS = ["科技数码", "职场成长", "美食探店", "娱乐八卦", "财经理财", "健康养生", "教育学习", "旅行出行"];

// 领域最多同时选中的数量：选满后再点会弹窗让用户挑一个替换
const MAX_DOMAINS = 3;

export default function Home() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([...DEFAULT_PLATFORMS]);
  const [domainOptions, setDomainOptions] = useState<string[]>([...DOMAINS]);
  // 默认什么都不选中 → 单纯呈现所有平台 top 热点（保留热点标签，不做领域分类筛选）
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  // 选满 MAX_DOMAINS 后再点的那个领域，暂存于此并弹出「替换哪个」弹窗；null=未触发
  const [replaceCandidate, setReplaceCandidate] = useState<string | null>(null);
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  // 添加/编辑领域时填写的释义（含义说明），传给后端做精确判定
  const [noteInput, setNoteInput] = useState("");
  // 正在编辑的自创领域名（null 表示当前是「新增」而非「编辑」）
  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  // 点击「确认」后模型识别出的候选释义列表
  const [meaningOptions, setMeaningOptions] = useState<string[]>([]);
  // 是否正在请求候选释义
  const [meaningLoading, setMeaningLoading] = useState(false);
  // 已点过「确认」（用于控制界面进入第二步展示候选释义）
  const [meaningConfirmed, setMeaningConfirmed] = useState(false);
  // 记录上一次「确认」时的名称，名称变化后需要重新确认
  const [meaningForName, setMeaningForName] = useState("");
  // 每个自创领域对应的释义：{ 领域名: 释义 }
  const [domainNotes, setDomainNotes] = useState<Record<string, string>>({});
  // 领域收进标题栏的下拉菜单（both 为移动端合并下拉）；平台编辑已统一收进平台选择弹窗
  const [openMenu, setOpenMenu] = useState<null | "domain" | "both">(null);
  // 平台选择弹窗：打开时把 selectedPlatforms 快照进 draft，点「确定」才写回（取消即丢弃）
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false);
  const [draftPlatforms, setDraftPlatforms] = useState<string[]>([]);
  // 顶部完整选择区是否还在可视范围内（滚出后才在标题栏显示下拉入口）
  const [selectorsVisible, setSelectorsVisible] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([
    { id: DEFAULT_SESSION_ID, title: "新会话", messages: [WELCOME] },
  ]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_SESSION_ID);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [pendingDeleteDomain, setPendingDeleteDomain] = useState<string | null>(
    null
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false); // 失败卡片「重试」进行中：按钮转圈，结束仍失败则卡片闪一下
  const [hydrated, setHydrated] = useState(false);
  // 跨设备同步（同步码方案，无需登录）
  const [syncCode, setSyncCode] = useState("");
  // 隐藏设备标识：首次访问自动生成并存本地，仅用于「定时任务」在服务端认领任务、静默回传结果。
  // 未启用同步码时，定时任务就用它当身份；用户无感，界面不出现。
  const [deviceId, setDeviceId] = useState("");
  const [showSync, setShowSync] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  // 每条热点的「查看详情」展开状态，按会话隔离（外层 key = 会话 id，内层 key = 消息序号:行号）。
  // 持久化到 localStorage：只要点开查看过，刷新后展开/收起（及生成脚本）按钮就一直常驻。
  const [detailsBySession, setDetailsBySession] = useState<
    Record<string, Record<string, DetailState>>
  >({});
  // 「热点标题 → 原文链接」映射，跨多次回复累积并持久化。点「查看详情」时把这条热点的原报道
  // url 一并发给 /api/detail，让详情接口把主报道无条件置顶为核心来源。
  const [topicUrlMap, setTopicUrlMap] = useState<Record<string, string>>({});
  // 热榜速报「按平台聚合 / 按领域聚合」开关（2026-09）：key=会话id:消息序号，true=按领域。
  // 默认按平台（线上既有形态）；仅当该条速报确实含≥2个平台分节且跨≥2个领域标签时才出现入口。
  const [boardDomainView, setBoardDomainView] = useState<Record<string, boolean>>({});
  // 消息多选删除：长按(移动端)/悬浮工具栏删除按钮(桌面端) 唤起编辑态，勾选后统一删除
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMsgs, setSelectedMsgs] = useState<number[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // 设置菜单（同步 / 定时任务）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedEveryDays, setSchedEveryDays] = useState(1);
  const [schedTimes, setSchedTimes] = useState<string[]>(["09:00"]);
  // 日期/时间滚轮弹层：记录触发框位置（fixed 定位用），null = 关闭
  const [startDatePop, setStartDatePop] = useState<{ top: number; left: number } | null>(null);
  const [endDatePop, setEndDatePop] = useState<{ top: number; left: number } | null>(null);
  const [timePopIdx, setTimePopIdx] = useState<{ idx: number; top: number; left: number } | null>(null);
  // 开始日期默认当天，结束日期选填（空=一直执行）
  const [schedStartDate, setSchedStartDate] = useState("");
  const [schedEndDate, setSchedEndDate] = useState("");
  // 结束日期为空时展示「永久运行」占位，点击后切换为原生日期选择器
  const [schedEndEditing, setSchedEndEditing] = useState(false);
  // 是否处于可编辑状态：已保存过配置时先进入只读态（按钮显示「编辑」），点编辑后才可改
  const [schedEditMode, setSchedEditMode] = useState(true);
  // 定时任务专属的领域 / 平台选择（与主页面互不影响；打开时默认填充主页面当前选择）
  const [schedDomains, setSchedDomains] = useState<string[]>([]);
  const [schedPlatforms, setSchedPlatforms] = useState<string[]>([]);
  // 定时任务里领域选满 MAX_DOMAINS 后再点触发的「替换哪个」弹窗
  const [schedReplaceCandidate, setSchedReplaceCandidate] = useState<string | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  // 删除定时任务的二次确认弹窗开关
  const [schedConfirmDelete, setSchedConfirmDelete] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [schedLoaded, setSchedLoaded] = useState(false);
  // 🤖 AI 模型（BYOK）：下拉选平台 + 填自己的 API Key。配置只存本机 localStorage，
  // 随每次请求上送给后端使用；不填 Key 则走系统默认（DeepSeek），站点开箱即用。
  const [showLlm, setShowLlm] = useState(false);
  // 移动端平台链接唤起失败/微信内浏览器拦截时的操作表（见 openPlatformUrl）
  const [appJumpSheet, setAppJumpSheet] = useState<{
    appName: string;
    schemes: string[];
    webUrl: string;
    dl?: string;
    blocked: boolean; // true=微信/QQ 内置浏览器，scheme 被屏蔽
  } | null>(null);
  const [llmSaved, setLlmSaved] = useState<LlmOverride | null>(null);
  // 弹窗内草稿：Key 输入框留空表示「不改动已保存的 Key」，避免明文回显
  const [llmProvider, setLlmProvider] = useState("deepseek");
  const [llmKeyInput, setLlmKeyInput] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmTestMsg, setLlmTestMsg] = useState<{ ok: boolean; text: string; action?: LlmErrorAction | null } | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectorsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipPush = useRef(false);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const setActiveMessages = (updater: (prev: Message[]) => Message[]) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, messages: updater(s.messages) } : s
      )
    );
  };

  // 当前会话的「查看详情」展开状态，及只更新当前会话那一份的辅助函数
  const details = detailsBySession[activeId] || {};
  const updateDetails = (
    fn: (prev: Record<string, DetailState>) => Record<string, DetailState>
  ) =>
    setDetailsBySession((p) => ({ ...p, [activeId]: fn(p[activeId] || {}) }));

  // ===== 生成脚本弹窗 =====
  type ScriptType = "口播稿" | "情景演绎" | "AI生视频";
  // 脚本时长离散档位：30秒起、30秒步长、至5分钟；每档附带口播参考字数
  const DURATION_STEPS = [
    { label: "30秒", words: "90-110字" },
    { label: "1分钟", words: "180-220字" },
    { label: "1分30秒", words: "270-330字" },
    { label: "2分钟", words: "360-440字" },
    { label: "2分30秒", words: "450-550字" },
    { label: "3分钟", words: "540-660字" },
    { label: "3分30秒", words: "630-770字" },
    { label: "4分钟", words: "720-880字" },
    { label: "4分30秒", words: "810-990字" },
    { label: "5分钟", words: "900-1100字" },
  ];
  // 非 null 时弹窗打开，携带目标热点的话题/平台/已抓取的详细报道（作为生成脚本的事实依据）
  const [scriptModal, setScriptModal] = useState<
    {
      topic: string;
      platform: string;
      report: string;
      material?: { oneLine?: string; memes?: string[]; angles?: string[]; timeline?: string[]; facts?: string[]; thin?: boolean } | null;
      entity?: string;
      // 详情面板召回的真实参考链接（含搜索快照）：写稿时后端抓全文/退回快照用
      sites?: { title: string; url: string; source?: string; date?: string; snippet?: string }[];
    } | null
  >(null);
  const [scriptType, setScriptType] = useState<ScriptType>("口播稿");
  const [scriptPlot, setScriptPlot] = useState(""); // 脚本(选填)
  const [scriptEmbed, setScriptEmbed] = useState(""); // 希望植入的梗、台词或桥段
  const [polishing, setPolishing] = useState(false); // 润色梗概进行中
  const [scriptGenerating, setScriptGenerating] = useState(false); // 一键生成进行中
  const [durationIdx, setDurationIdx] = useState(2); // 脚本时长档位，默认 1分30秒（index 2）
  const [multiLoading, setMultiLoading] = useState(false); // 一稿多发生成中
  const [multiPack, setMultiPack] = useState<MultiPack | null>(null); // 一稿多发结果
  // 梗概框填入反馈：从素材卡点时间线/角度填入时，输入框柔和高亮一次（纯前端提示，
  // 让"填到哪了"看得见；连点可重放，故用 nonce 强制重挂动画类）
  const [plotFlash, setPlotFlash] = useState(0);
  const plotFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次素材填入所属选题：弹窗被取消后草稿暂存，同选题续点继续追加、换选题清空
  const draftTopicRef = useRef("");
  const triggerPlotFlash = () => {
    if (plotFlashTimer.current) clearTimeout(plotFlashTimer.current);
    setPlotFlash(0);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setPlotFlash((n) => n + 1);
        plotFlashTimer.current = setTimeout(() => setPlotFlash(0), 850);
      })
    );
  };

  const openScriptModal = (
    topic: string,
    platform: string,
    report: string,
    material?: DetailData["material"],
    entity = "",
    sites?: DetailData["sites"]
  ) => {
    setScriptType("口播稿");
    setScriptPlot("");
    setScriptEmbed("");
    setPolishing(false);
    setScriptGenerating(false);
    setDurationIdx(2);
    setMultiLoading(false);
    setMultiPack(null);
    // 只透传真实文章链接（"去搜索"入口对抓全文无意义）
    const realSites = (sites || []).filter((s) => s?.url && !s.search);
    setScriptModal({ topic, platform, report, material: material ?? null, entity, sites: realSites });
  };

  // 从「口播素材」卡片点击金句/角度，回填到生成脚本弹窗对应输入框：
  // 金句 → 「希望植入的梗」（embed），角度 → 「梗概」（plot）。
  // 弹窗未开则打开弹窗（同选题保留已暂存的草稿并追加，换选题清空重开）；已开则去重后追加。
  const fillScriptField = (
    field: "embed" | "plot",
    text: string,
    ctx: {
      topic: string;
      platform: string;
      report: string;
      material?: DetailData["material"];
      entity?: string;
      sites?: DetailData["sites"];
    }
  ) => {
    const clean = cleanMarkdown(text).trim();
    if (!clean) return;
    // 取消/遮罩关闭后草稿仍保留在 scriptPlot/scriptEmbed 里。同一选题再次点素材
    // （时间线要关弹窗才能点下一条）必须在旧草稿上继续追加，否则"条2→关弹窗→条3"
    // 会只剩条3；换了选题则旧草稿作废、干净重开。
    const sameTopicDraft =
      !scriptModal && draftTopicRef.current && draftTopicRef.current === ctx.topic;
    if (!scriptModal) {
      setScriptType("口播稿");
      setDurationIdx(2);
      setPolishing(false);
      setScriptGenerating(false);
      if (!sameTopicDraft) {
        setScriptEmbed(field === "embed" ? clean : "");
        setScriptPlot(field === "plot" ? clean : "");
        if (field === "plot") triggerPlotFlash();
      }
      draftTopicRef.current = ctx.topic;
      setScriptModal({
        topic: ctx.topic,
        platform: ctx.platform,
        report: ctx.report,
        material: ctx.material ?? null,
        entity: ctx.entity || "",
        sites: (ctx.sites || []).filter((s) => s?.url && !s.search),
      });
      if (sameTopicDraft) {
        // 同选题续点：在保留的草稿上追加（去重规则与弹窗打开时一致）
        if (field === "embed")
          setScriptEmbed((p) =>
            p.includes(clean) ? p : p ? `${p}；${clean}` : clean
          );
        else if (!scriptPlot.includes(clean)) {
          setScriptPlot((p) => (p ? `${p}\n${clean}` : clean));
          triggerPlotFlash();
        }
      }
      return;
    }
    // 金句（embed）去重追加；梗概（plot）所有素材入口（时间线整条/单条、角度）
    // 一律去重追加，已填入的条在卡片上显示✓选中态
    if (field === "embed")
      setScriptEmbed((p) =>
        p.includes(clean) ? p : p ? `${p}；${clean}` : clean
      );
    else if (!scriptPlot.includes(clean)) {
      setScriptPlot(scriptPlot ? `${scriptPlot}\n${clean}` : clean);
      triggerPlotFlash();
    }
  };

  // 润色梗概：把用户写的想法，结合热点事件、已抓取报道与爆款库里的结构套路，
  // 理成一段 100 字左右的梗概（只是提纲，不是成稿），回填到梗概框
  const polishPlot = async () => {
    if (!scriptModal || !scriptPlot.trim() || polishing) return;
    setPolishing(true);
    try {
      const res = await fetch("/api/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "polish",
          topic: scriptModal.topic,
          platform: scriptModal.platform,
          report: scriptModal.report,
          entity: scriptModal.entity || "",
          sites: scriptModal.sites ?? [],
          type: scriptType,
          plot: scriptPlot,
          // 传当前锁定领域，让后端从爆款库里先收窄候选模板再按相关性挑
          domain: selectedDomains.join("、"),
          llm: llmPayload(),
        }),
      });
      const data = await res.json();
      if (data?.script) setScriptPlot(String(data.script).trim());
    } catch (e) {
      console.error("[ui] 脚本润色请求失败:", e);
    } finally {
      setPolishing(false);
    }
  };

  // 一键生成脚本：综合类型 + 脚本框内容 + 待植入元素 + 热点事件与报道，生成最终脚本并作为一条消息插入对话
  const generateScript = async () => {
    if (!scriptModal || scriptGenerating) return;
    const { topic, platform, report } = scriptModal;
    const type = scriptType;
    setScriptGenerating(true);
    try {
      const res = await fetch("/api/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          topic,
          platform,
          report,
          entity: scriptModal.entity || "",
          sites: scriptModal.sites ?? [],
          type,
          script: scriptPlot,
          embed: scriptEmbed,
          // 详情面板抓到的热梗/事实自动带上（服务端标注"选用不硬塞"）；
          // 用户手动点chip植入走 embed，两边不冲突
          memes: scriptModal.material?.memes ?? [],
          facts: scriptModal.material?.facts ?? [],
          duration: DURATION_STEPS[durationIdx].label,
          wordRange: DURATION_STEPS[durationIdx].words,
          domain: selectedDomains.join("、"),
          llm: llmPayload(),
        }),
      });
      const data = await res.json();
      // Key 缺失/无效/欠费：在对话区插引导卡（配置 Key / 充值直达按钮），
      // 保留脚本弹窗——用户配好 Key / 充值后可直接再点「生成」，不用重走选题
      if (data?.llmError) {
        setActiveMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            failed: true,
            kind: "script",
            content: data.llmError.message,
            llmError: data.llmError,
          },
        ]);
        return;
      }
      const script = (data?.script && String(data.script).trim()) || "脚本生成失败，请稍后重试。";
      // 素材量撑不住所选时长时后端自动降档，把原因摆在成稿最前面（不替用户假装长稿）
      const downgradeNote = data?.downgrade ? `⚠️ ${String(data.downgrade)}\n\n` : "";
      setActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          kind: "script",
          content: `🎬 视频脚本（${type}）｜${topic}\n\n${downgradeNote}${script}`,
        },
      ]);
      setScriptModal(null);
    } catch (e) {
      console.error("[ui] 视频脚本生成请求失败:", e);
      setActiveMessages((prev) => [
        ...prev,
        { role: "assistant", kind: "script", content: "脚本生成失败，请稍后重试。" },
      ]);
      setScriptModal(null);
    } finally {
      setScriptGenerating(false);
    }
  };

  // 一稿多发：同一选题，按平台直接生成可发布成稿（小红书图文 / 公众号短文）
  const generateMulti = async () => {
    if (!scriptModal || multiLoading) return;
    setMultiLoading(true);
    try {
      const res = await fetch("/api/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "multi",
          topic: scriptModal.topic,
          platform: scriptModal.platform,
          report: scriptModal.report,
          entity: scriptModal.entity || "",
          sites: scriptModal.sites ?? [],
          script: scriptPlot,
          embed: scriptEmbed,
          domain: selectedDomains.join("、"),
          llm: llmPayload(),
        }),
      });
      const data = await res.json();
      setMultiPack((data?.pack as MultiPack) || null);
    } catch (e) {
      console.error("[ui] 一稿多发请求失败:", e);
      setMultiPack(null);
    } finally {
      setMultiLoading(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 顶部领域/平台选择区滚出可视范围时，才在标题栏显示下拉入口
  useEffect(() => {
    const el = selectorsRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const ob = new IntersectionObserver(
      ([entry]) => setSelectorsVisible(entry.isIntersecting),
      { root, threshold: 0 }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [activeId]);

  // 首次加载：从 localStorage 恢复领域设置与会话
  useEffect(() => {
    try {
      const savedOptions = localStorage.getItem("domainOptions");
      const savedSelected = localStorage.getItem("selectedDomains");
      const savedNotes = localStorage.getItem("domainNotes");
      // 迁移旧默认分类 → 新默认分类：删除已不在新默认集里的旧默认项，保留用户自建领域，
      // 新默认项统一前置。这样"改默认分类"对老用户（localStorage 存了旧默认）也即时生效。
      let mergedOptions: string[] = [...DOMAINS];
      if (savedOptions) {
        const persisted = JSON.parse(savedOptions);
        if (Array.isArray(persisted)) {
          const customs = persisted.filter(
            (d: unknown): d is string =>
              typeof d === "string" &&
              !LEGACY_DEFAULT_DOMAINS.includes(d) &&
              !DOMAINS.includes(d)
          );
          mergedOptions = [...DOMAINS, ...customs];
        }
      }
      setDomainOptions(mergedOptions);
      if (savedSelected) {
        const arr = JSON.parse(savedSelected);
        // 兼容旧数据：以前可能存了全选(8个)，现在上限是 MAX_DOMAINS；同时剔除迁移后已不存在的领域。
        if (Array.isArray(arr))
          setSelectedDomains(
            arr
              .filter((d: string) => mergedOptions.includes(d))
              .slice(0, MAX_DOMAINS)
          );
      }
      if (savedNotes) setDomainNotes(JSON.parse(savedNotes));

      const savedCode = localStorage.getItem("syncCode");
      if (savedCode) setSyncCode(savedCode);

      // 恢复「查看详情」展开状态：只要之前点开查看过，刷新后按钮就常驻。
      // V2：详情卡结构/文案迭代后，旧版本缓存的详情内容（旧基本资料、旧参考列表）
      // 会让用户永远看到改版前的结果，故缓存键升版一次性作废，已开条目重新拉取。
      const savedDetails = localStorage.getItem("detailsBySessionV2");
      if (savedDetails) {
        const parsed = JSON.parse(savedDetails);
        if (parsed && typeof parsed === "object") setDetailsBySession(parsed);
      }

      // 恢复「标题 → 原文链接」映射，保证刷新后点详情仍能把主报道置顶为核心来源
      const savedTopicUrls = localStorage.getItem("topicUrlMap");
      if (savedTopicUrls) {
        const parsed = JSON.parse(savedTopicUrls);
        if (parsed && typeof parsed === "object") setTopicUrlMap(parsed);
      }

      // 恢复 AI 模型配置（BYOK）：只恢复结构，Key 不回显明文
      const savedLlm = localStorage.getItem("llmConfig");
      if (savedLlm) {
        try {
          const parsed = JSON.parse(savedLlm);
          if (parsed && typeof parsed === "object" && typeof parsed.apiKey === "string") {
            setLlmSaved(parsed);
          }
        } catch (e) {
          console.debug("[ui] 读取本地 llmConfig 失败，按未配置处理:", e);
        }
      }

      // 隐藏设备标识：没有就生成一个（复用同步码格式，满足服务端 code 校验）
      let dev = localStorage.getItem("deviceId");
      if (!dev) {
        dev = genSyncCode();
        try {
          localStorage.setItem("deviceId", dev);
        } catch (e) {
          console.debug("[ui] deviceId 写入 localStorage 失败:", e);
        }
      }
      setDeviceId(dev);

      const savedSessions = localStorage.getItem("sessions");
      const savedActive = localStorage.getItem("activeSessionId");
      if (savedSessions) {
        const parsed = JSON.parse(savedSessions);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSessions(parsed);
          const validActive =
            savedActive && parsed.some((s: Session) => s.id === savedActive);
          setActiveId(validActive ? savedActive! : parsed[0].id);
        }
      } else {
        // 迁移旧版单会话聊天记录
        const savedMessages = localStorage.getItem("chatMessages");
        if (savedMessages) {
          const parsed = JSON.parse(savedMessages);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const migrated: Session = {
              id: DEFAULT_SESSION_ID,
              title: "历史会话",
              messages: parsed,
            };
            setSessions([migrated]);
            setActiveId(migrated.id);
          }
        }
      }
    } catch (e) {
      console.debug("[ui] 启动时从 localStorage 恢复本地状态失败，按全新状态启动:", e);
    }
    setHydrated(true);
  }, []);

  // 领域设置变化时持久化（轻量：只序列化领域相关数据，不碰 sessions）
  // 拆分出来是为了让“领域切换”这类高频操作不再同步序列化整个会话历史，
  // 否则每点一个领域芯片都会 JSON.stringify(sessions) 卡住主线程 → 切换迟钝。
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("domainOptions", JSON.stringify(domainOptions));
      localStorage.setItem("selectedDomains", JSON.stringify(selectedDomains));
      localStorage.setItem("domainNotes", JSON.stringify(domainNotes));
    } catch (e) {
      console.debug("[ui] 领域设置写入 localStorage 失败:", e);
    }
  }, [hydrated, domainOptions, selectedDomains, domainNotes]);

  // 会话变化时才持久化 sessions（重数据单独一个 effect）
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("sessions", JSON.stringify(sessions));
      localStorage.setItem("activeSessionId", activeId);
    } catch (e) {
      console.debug("[ui] 会话记录写入 localStorage 失败:", e);
    }
  }, [hydrated, sessions, activeId]);

  // 持久化「查看详情」展开状态。只存已成功加载出详情的条目（剔除 loading/失败态），
  // 保证刷新后按钮常驻且能立即展开，也不会把加载中/失败的半成品状态存进去。
  useEffect(() => {
    if (!hydrated) return;
    try {
      const clean: Record<string, Record<string, DetailState>> = {};
      for (const [sid, map] of Object.entries(detailsBySession)) {
        const m: Record<string, DetailState> = {};
        for (const [k, v] of Object.entries(map || {})) {
          if (v?.data && !v.loading && !v.error) {
            m[k] = { open: v.open, loading: false, data: v.data };
          }
        }
        if (Object.keys(m).length) clean[sid] = m;
      }
      localStorage.setItem("detailsBySessionV2", JSON.stringify(clean));
    } catch (e) {
      console.debug("[ui] 详情展开状态写入 localStorage 失败:", e);
    }
  }, [hydrated, detailsBySession]);

  // 持久化「标题 → 原文链接」映射
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("topicUrlMap", JSON.stringify(topicUrlMap));
    } catch (e) {
      console.debug("[ui] 标题链接映射写入 localStorage 失败:", e);
    }
  }, [hydrated, topicUrlMap]);

  // ===== 跨设备同步 =====
  const buildPayload = () => ({
    sessions,
    activeId,
    domainOptions,
    selectedDomains,
    domainNotes,
  });

  const applyPayload = (p: any) => {
    if (!p) return;
    skipPush.current = true; // 应用云端数据后不要立刻回推
    if (Array.isArray(p.sessions) && p.sessions.length > 0) {
      setSessions(p.sessions);
      const valid =
        p.activeId && p.sessions.some((s: Session) => s.id === p.activeId);
      setActiveId(valid ? p.activeId : p.sessions[0].id);
    }
    if (Array.isArray(p.domainOptions)) setDomainOptions(p.domainOptions);
    if (Array.isArray(p.selectedDomains)) setSelectedDomains(p.selectedDomains);
    if (p.domainNotes && typeof p.domainNotes === "object")
      setDomainNotes(p.domainNotes);
  };

  const pushSync = async (code: string) => {
    if (!code) return;
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, payload: buildPayload() }),
      });
      const data = await res.json();
      if (res.ok) setLastSyncAt(data.updatedAt || Date.now());
    } catch (e) {
      console.warn("[ui] 同步推送到云端失败:", e);
    }
  };

  const pullSync = async (code: string, silent = false): Promise<boolean> => {
    if (!code) return false;
    if (!silent) {
      setSyncBusy(true);
      setSyncMsg(null);
    }
    try {
      const res = await fetch(`/api/sync?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        if (!silent) setSyncMsg({ ok: false, text: data.error || "拉取失败" });
        return false;
      }
      applyPayload(data.payload);
      setLastSyncAt(data.updatedAt || 0);
      if (!silent) setSyncMsg({ ok: true, text: "已从云端拉取最新数据" });
      return true;
    } catch (e) {
      console.warn("[ui] 从云端拉取同步数据失败:", e);
      if (!silent) setSyncMsg({ ok: false, text: "网络异常，请稍后重试" });
      return false;
    } finally {
      if (!silent) setSyncBusy(false);
    }
  };

  // 定时任务身份：优先用同步码（有则结果并入同步数据、可跨设备），否则用隐藏设备标识（无感、仅本设备）
  const scheduleCode = syncCode || deviceId;

  // 仅拉取并合并「⏰ 定时任务」专属会话，不动其它会话/领域设置（供无同步码时静默回传结果用）
  const pullScheduled = async (code: string) => {
    if (!code) return;
    try {
      const res = await fetch(`/api/sync?code=${encodeURIComponent(code)}`);
      if (!res.ok) return;
      const data = await res.json();
      const p = data?.payload;
      const cloudSessions = Array.isArray(p?.sessions) ? p.sessions : [];
      const sched = cloudSessions.find((s: any) => s?.id === "scheduled");
      if (!sched) return;
      skipPush.current = true; // 合并云端定时结果后不要立刻回推
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== "scheduled");
        return [sched, ...others]; // 定时会话置顶，其余保持不动
      });
    } catch (e) {
      console.warn("[ui] 静默拉取定时任务结果失败:", e);
    }
  };

  const enableSync = async () => {
    const code = genSyncCode();
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, payload: buildPayload() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncMsg({ ok: false, text: data.error || "启用失败" });
        return;
      }
      setSyncCode(code);
      try {
        localStorage.setItem("syncCode", code);
      } catch (e) {
        console.debug("[ui] 启用同步：syncCode 写入 localStorage 失败:", e);
      }
      setLastSyncAt(data.updatedAt || Date.now());
      setSyncMsg({ ok: true, text: "已启用同步，请在其他设备输入此码" });
    } catch (e) {
      console.warn("[ui] 启用同步请求失败:", e);
      setSyncMsg({ ok: false, text: "网络异常，请稍后重试" });
    } finally {
      setSyncBusy(false);
    }
  };

  const importCode = async () => {
    const c = codeInput.trim();
    if (!c) return;
    const ok = await pullSync(c, false);
    if (ok) {
      setSyncCode(c);
      try {
        localStorage.setItem("syncCode", c);
      } catch (err) {
        console.debug("[ui] 绑定同步码：syncCode 写入 localStorage 失败:", err);
      }
      setSyncMsg({ ok: true, text: "已导入并绑定该同步码" });
      setCodeInput("");
    }
  };

  const disableSync = () => {
    setSyncCode("");
    try {
      localStorage.removeItem("syncCode");
    } catch (err) {
      console.debug("[ui] 停用同步：移除 localStorage 中的 syncCode 失败:", err);
    }
    setSyncMsg({ ok: true, text: "已停用同步，数据仅保留在本设备" });
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(syncCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.debug("[ui] 复制同步码到剪贴板失败:", e);
    }
  };

  // ===== 定时任务 =====
  // 本地今天（YYYY-MM-DD），用于开始日期默认填充
  const todayStr = () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  // 定时任务里的领域选择：逻辑与主页面 toggleDomain 完全一致（上限 MAX_DOMAINS，选满再点弹替换）
  const toggleSchedDomain = (d: string) => {
    if (schedDomains.includes(d)) {
      setSchedDomains((prev) => prev.filter((x) => x !== d));
      return;
    }
    if (schedDomains.length >= MAX_DOMAINS) {
      setSchedReplaceCandidate(d);
      return;
    }
    setSchedDomains((prev) => [...prev, d]);
  };
  const confirmSchedReplaceDomain = (victim: string) => {
    if (!schedReplaceCandidate) return;
    setSchedDomains((prev) =>
      prev.map((x) => (x === victim ? schedReplaceCandidate : x))
    );
    setSchedReplaceCandidate(null);
  };
  const toggleSchedPlatform = (p: string) => {
    setSchedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  // 与 sendMessage 保持一致地构造领域/平台/释义快照，供服务端定时抓取复用
  const buildScheduleSnapshot = () => {
    // 与主页面一致：空选=不锁定领域(呈现全部热点)，选了才逐个过滤
    const domain = schedDomains.length === 0 ? "" : schedDomains.join("、");
    const glossary: Record<string, string> = {};
    for (const d of schedDomains) {
      const note = domainNotes[d];
      if (note && note.trim()) glossary[d] = note.trim();
    }
    return {
      domain,
      platforms: schedPlatforms,
      glossary,
      allDomains: domainOptions,
    };
  };

  // ===== 🤖 AI 模型设置（BYOK：平台下拉 + 自带 Key）=====
  // 打开弹窗：用已保存配置填草稿（Key 输入框永远留空，不回显明文）
  const openLlmSettings = () => {
    setSettingsOpen(false);
    const base = llmSaved || {};
    const preset = getProviderPreset(base.provider);
    setLlmProvider(base.provider || "deepseek");
    setLlmKeyInput("");
    setLlmBaseUrl(base.baseUrl || preset.baseUrl);
    setLlmModel(base.model || preset.model);
    setLlmTestMsg(null);
    setShowLlm(true);
  };

  // 切换平台：自动带出该平台预设的接口地址与默认模型
  const onLlmProviderChange = (id: string) => {
    setLlmProvider(id);
    const preset = getProviderPreset(id);
    setLlmBaseUrl(preset.baseUrl);
    setLlmModel(preset.model);
    setLlmTestMsg(null);
  };

  // 当前生效 Key：本次新输入优先，否则沿用已保存的
  const llmEffectiveKey = () => llmKeyInput.trim() || llmSaved?.apiKey || "";

  // 组装随请求上送的配置：有有效 Key 才带；没有就走服务端系统默认（DeepSeek）
  const llmPayload = (): LlmOverride | undefined => {
    const key = llmEffectiveKey();
    if (!key) return undefined;
    return {
      provider: llmProvider,
      apiKey: key,
      baseUrl: llmBaseUrl.trim(),
      model: llmModel.trim(),
    };
  };

  const llmSave = () => {
    const payload = llmPayload();
    setLlmSaved(payload ?? null);
    try {
      if (payload) localStorage.setItem("llmConfig", JSON.stringify(payload));
      else localStorage.removeItem("llmConfig");
    } catch (e) {
      console.debug("[ui] 保存 LLM 配置到 localStorage 失败:", e);
    }
    setShowLlm(false);
    // 刚配好 Key 且末尾停着失败卡（上一轮提问因没 Key/欠费被截断）：
    // 关掉弹窗后自动用原提问重发，不用用户再手动点一次重试。
    if (payload) {
      const lastM = messages[messages.length - 1];
      if (lastM?.failed && lastM.kind !== "script" && lastChatRef.current) {
        setTimeout(() => retryChat(), 250);
      }
    }
  };

  const llmClear = () => {
    setLlmSaved(null);
    setLlmKeyInput("");
    try {
      localStorage.removeItem("llmConfig");
    } catch (e) {
      console.debug("[ui] 清除 LLM 配置：localStorage 移除失败:", e);
    }
    setLlmTestMsg({ ok: true, text: "已清除你的 Key，之后将使用系统默认模型（DeepSeek）。" });
  };

  const llmTest = async () => {
    setLlmBusy(true);
    setLlmTestMsg(null);
    try {
      const payload = llmPayload();
      const res = await fetch("/api/llm-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ? { llm: payload } : {}),
      });
      const data = await res.json();
      if (data?.ok) {
        setLlmTestMsg({
          ok: true,
          text: `连接成功 ✓ ${getProviderPreset(data.provider).name} · 模型 ${data.model}${
            data.usingOwnKey ? "" : "（系统默认 Key）"
          }`,
        });
      } else {
        setLlmTestMsg({
          ok: false,
          text: `连接失败：${data?.error || "未知错误"}`,
          action: data?.llmError ?? null,
        });
      }
    } catch (e) {
      setLlmTestMsg({ ok: false, text: `连接失败：${(e as Error).message}` });
    } finally {
      setLlmBusy(false);
    }
  };

  const openSchedule = async () => {
    setSettingsOpen(false);
    setSchedMsg(null);
    setSchedReplaceCandidate(null);
    setShowSchedule(true);
    // 默认填充：开始日期=今天、结束日期=空、领域/平台=主页面当前选择
    setSchedStartDate(todayStr());
    setSchedEndDate("");
    setSchedEndEditing(false);
    setSchedTimes(["09:00"]);
    setSchedDomains([...selectedDomains].slice(0, MAX_DOMAINS));
    setSchedPlatforms([...selectedPlatforms]);
    // 没有同步码 = 全新配置，直接可编辑
    setSchedEditMode(true);
    if (!scheduleCode) return;
    setSchedLoaded(false);
    try {
      const res = await fetch(`/api/schedule?code=${encodeURIComponent(scheduleCode)}`);
      const data = await res.json();
      if (res.ok && data.config) {
        const cfg = data.config;
        setSchedEnabled(cfg.enabled !== false);
        setSchedEveryDays(cfg.everyDays || 1);
        setSchedTimes(
          Array.isArray(cfg.times) && cfg.times.length
            ? cfg.times
            : ["09:00"]
        );
        // 已有配置：回显开始/结束日期与领域/平台
        setSchedStartDate(cfg.anchor || todayStr());
        setSchedEndDate(cfg.endDate || "");
        setSchedEndEditing(false);
        // 已存在配置 → 先进入只读态，按钮显示「编辑」
        setSchedEditMode(false);
        const snap = cfg.snapshot || {};
        setSchedDomains(
          typeof snap.domain === "string" && snap.domain
            ? snap.domain.split("、").filter(Boolean).slice(0, MAX_DOMAINS)
            : []
        );
        setSchedPlatforms(
          Array.isArray(snap.platforms) ? snap.platforms : [...selectedPlatforms]
        );
      }
    } catch (e) {
      console.warn("[ui] 拉取定时任务已有配置失败，按全新配置展示:", e);
    }
    setSchedLoaded(true);
  };

  const saveSchedule = async () => {
    if (!scheduleCode) return;
    const times = Array.from(new Set(schedTimes.filter((t) => /^\d{1,2}:\d{2}$/.test(t)))).slice(0, 3);
    if (times.length === 0) {
      setSchedMsg({ ok: false, text: "至少配置一个触发时间" });
      return;
    }
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(schedStartDate)
      ? schedStartDate
      : todayStr();
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(schedEndDate) ? schedEndDate : "";
    if (endDate && endDate < startDate) {
      setSchedMsg({ ok: false, text: "结束日期不能早于开始日期" });
      return;
    }
    if (schedPlatforms.length === 0) {
      setSchedMsg({ ok: false, text: "至少选择一个抓取平台" });
      return;
    }
    // 强制 BYOK：定时任务到点无人值守，必须用创建者自己的 Key（随任务加密存储于云端）
    const schedLlm = llmPayload();
    if (!schedLlm?.apiKey) {
      setSchedMsg({
        ok: false,
        text: "请先在「🤖 AI 模型」里填写并保存你自己的 API Key，再创建定时任务（自动抓取花你自己的额度）",
      });
      return;
    }
    setSchedBusy(true);
    setSchedMsg(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: scheduleCode,
          enabled: schedEnabled,
          everyDays: schedEveryDays,
          times,
          startDate,
          endDate,
          snapshot: { ...buildScheduleSnapshot(), llm: schedLlm },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const rangeText = endDate
          ? `${startDate} 起至 ${endDate}`
          : `${startDate} 起长期执行`;
        setSchedMsg({
          ok: true,
          text: schedEnabled
            ? `已保存：${rangeText}，每 ${schedEveryDays} 天于 ${times.join("、")} 自动抓取热点，结果会自动回到本设备`
            : "已保存（定时任务已停用）",
        });
        // 保存成功后自动关闭弹窗（稍留时间让用户看到提示）
        setTimeout(() => setShowSchedule(false), 900);
      } else {
        setSchedMsg({ ok: false, text: data.error || "保存失败" });
      }
    } catch (e: any) {
      setSchedMsg({ ok: false, text: `保存失败：${e.message}` });
    } finally {
      setSchedBusy(false);
    }
  };

  const deleteScheduleCfg = async () => {
    if (!scheduleCode) return;
    setSchedBusy(true);
    setSchedMsg(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: scheduleCode }),
      });
      if (res.ok) {
        // 回到弹窗初始态（与首次打开一致），随后关闭弹窗
        setSchedEnabled(true);
        setSchedEveryDays(1);
        setSchedTimes(["09:00"]);
        setSchedStartDate(todayStr());
        setSchedEndDate("");
        setSchedEndEditing(false);
        setSchedEditMode(true);
        setSchedReplaceCandidate(null);
        setSchedDomains([...selectedDomains].slice(0, MAX_DOMAINS));
        setSchedPlatforms([...selectedPlatforms]);
        setSchedMsg(null);
        setSchedConfirmDelete(false);
        setShowSchedule(false);
      } else {
        const data = await res.json();
        setSchedConfirmDelete(false);
        setSchedMsg({ ok: false, text: data.error || "删除失败" });
      }
    } catch (e: any) {
      setSchedConfirmDelete(false);
      setSchedMsg({ ok: false, text: `删除失败：${e.message}` });
    } finally {
      setSchedBusy(false);
    }
  };


  // 首次加载后：已绑定同步码则拉全量云端数据（含定时结果）；否则用隐藏设备标识静默拉回定时结果
  useEffect(() => {
    if (!hydrated) return;
    if (syncCode) pullSync(syncCode, true);
    else if (deviceId) pullScheduled(deviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, deviceId]);

  // 数据变化时防抖自动上传（已绑定同步码时）
  useEffect(() => {
    if (!hydrated || !syncCode) return;
    if (skipPush.current) {
      skipPush.current = false;
      return;
    }
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => pushSync(syncCode), 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, domainOptions, selectedDomains, domainNotes, activeId, syncCode, hydrated]);

  // ===== 平台选择弹窗（两块布局：上=已选，下=未选；点选互移，最多 MAX_PLATFORMS 个）=====
  // 打开弹窗：快照当前选择进 draft，确定才提交，取消直接丢弃
  const openPlatformPicker = () => {
    // 按 PLATFORMS 顺序规范化，保证上块展示顺序稳定
    setDraftPlatforms(PLATFORMS.filter((p) => selectedPlatforms.includes(p)));
    setPlatformPickerOpen(true);
  };
  // draft 里添加一个平台（未选 → 已选）；选满 MAX_PLATFORMS 后忽略
  const addDraftPlatform = (p: string) => {
    setDraftPlatforms((prev) =>
      prev.includes(p) || prev.length >= MAX_PLATFORMS ? prev : [...prev, p]
    );
  };
  // draft 里移除一个平台（已选 → 未选）
  const removeDraftPlatform = (p: string) => {
    setDraftPlatforms((prev) => prev.filter((x) => x !== p));
  };
  // 清空 / 重置（重置 = 恢复产品默认的 8 个平台）
  const clearDraftPlatforms = () => setDraftPlatforms([]);
  const resetDraftPlatforms = () => setDraftPlatforms([...DEFAULT_PLATFORMS]);
  // 确认：按 PLATFORMS 顺序规范化后写回正式选择
  const confirmDraftPlatforms = () => {
    setSelectedPlatforms(PLATFORMS.filter((p) => draftPlatforms.includes(p)));
    setPlatformPickerOpen(false);
  };

  const toggleDomain = (d: string) => {
    // 已选中 → 取消选中
    if (selectedDomains.includes(d)) {
      setSelectedDomains((prev) => prev.filter((x) => x !== d));
      return;
    }
    // 未选中且已选满上限 → 弹窗让用户挑一个替换
    if (selectedDomains.length >= MAX_DOMAINS) {
      setReplaceCandidate(d);
      return;
    }
    // 未选满 → 直接加入
    setSelectedDomains((prev) => [...prev, d]);
  };

  // 在「替换哪个」弹窗里点选某个已选领域：用 replaceCandidate 顶掉它
  const confirmReplaceDomain = (victim: string) => {
    if (!replaceCandidate) return;
    setSelectedDomains((prev) =>
      prev.map((x) => (x === victim ? replaceCandidate : x))
    );
    setReplaceCandidate(null);
  };

  const clearDomains = () => setSelectedDomains([]);

  // 打开「新增领域」弹窗
  const openAddDomain = () => {
    setEditingDomain(null);
    setDomainInput("");
    setNoteInput("");
    resetMeaning();
    setShowDomainInput(true);
  };

  // 打开「编辑领域」弹窗，回显名称与释义
  const openEditDomain = (d: string) => {
    setEditingDomain(d);
    setDomainInput(d);
    setNoteInput(domainNotes[d] || "");
    resetMeaning();
    setShowDomainInput(true);
  };

  const closeDomainInput = () => {
    setShowDomainInput(false);
    setEditingDomain(null);
    setDomainInput("");
    setNoteInput("");
    resetMeaning();
  };

  // 清空候选释义相关状态
  const resetMeaning = () => {
    setMeaningOptions([]);
    setMeaningLoading(false);
    setMeaningConfirmed(false);
    setMeaningForName("");
  };

  // 点击「确认」：让模型识别领域含义并给出候选释义
  const confirmDomainMeaning = async () => {
    const name = domainInput.trim();
    if (!name) return;
    setMeaningConfirmed(true);
    setMeaningForName(name);
    setMeaningLoading(true);
    setMeaningOptions([]);
    try {
      const resp = await fetch("/api/domain-meaning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, llm: llmPayload() }),
      });
      const data = await resp.json();
      setMeaningOptions(Array.isArray(data?.options) ? data.options : []);
    } catch (e) {
      console.warn("[ui] 领域含义候选请求失败，降级为空:", e);
      setMeaningOptions([]);
    } finally {
      setMeaningLoading(false);
    }
  };

  // 保存领域（新增或编辑）：名称必填，释义可选
  const saveDomain = () => {
    const name = domainInput.trim();
    const note = noteInput.trim();
    if (!name) {
      closeDomainInput();
      return;
    }
    const old = editingDomain;
    if (old && old !== name) {
      // 编辑时改了名字：在选项/已选里替换旧名，并迁移释义
      setDomainOptions((prev) =>
        prev.map((x) => (x === old ? name : x)).filter((x, i, a) => a.indexOf(x) === i)
      );
      setSelectedDomains((prev) =>
        prev.includes(old)
          ? prev.map((x) => (x === old ? name : x)).filter((x, i, a) => a.indexOf(x) === i)
          : prev
      );
      setDomainNotes((prev) => {
        const next = { ...prev };
        delete next[old];
        if (note) next[name] = note;
        return next;
      });
    } else {
      // 新增，或编辑时名字没变
      setDomainOptions((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setSelectedDomains((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setDomainNotes((prev) => {
        const next = { ...prev };
        if (note) next[name] = note;
        else delete next[name];
        return next;
      });
    }
    closeDomainInput();
  };

  const deleteDomain = (d: string) => {
    setDomainOptions((prev) => prev.filter((x) => x !== d));
    setSelectedDomains((prev) => prev.filter((x) => x !== d));
    setDomainNotes((prev) => {
      const next = { ...prev };
      delete next[d];
      return next;
    });
    setPendingDeleteDomain(null);
    // 若正在编辑的就是被删的领域，一并关闭弹窗
    if (editingDomain === d) closeDomainInput();
  };

  const createSession = () => {
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setSidebarOpen(false);
  };

  // 把定时任务专属会话里的一条抓取记录导入新会话：带入配对的 user 抓取指令 + assistant 报告，
  // 用户可在新会话里围绕这次结果继续追问（模型拿到完整上下文）。定时专属会话本身不受影响。
  const importSchedToNewSession = (idx: number) => {
    const sched = sessions.find((s) => s.id === "scheduled");
    if (!sched) return;
    const report = sched.messages[idx];
    if (!report || report.role !== "assistant") return;
    let instruction: Session["messages"][number] | null = null;
    for (let k = idx - 1; k >= 0; k--) {
      if (sched.messages[k]?.role === "user") {
        instruction = sched.messages[k];
        break;
      }
    }
    const s = newSession();
    // 抓取指令带 [MM-DD HH:mm] 时间戳前缀，取来当会话标题；取不到就退回默认标题
    const stamp = instruction?.content.match(/^\[([^\]]+)\]/)?.[1];
    if (stamp) s.title = `定时导入 ${stamp}`;
    s.messages = [WELCOME, ...(instruction ? [instruction] : []), report];
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setSidebarOpen(false);
  };

  const deleteSession = (id: string) => {
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === 0) {
      const fresh = newSession();
      setSessions([fresh]);
      setActiveId(fresh.id);
    } else {
      setSessions(next);
      if (id === activeId) setActiveId(next[0].id);
    }
    setPendingDelete(null);
  };

  const switchSession = (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  const startRename = (s: Session) => {
    setRenamingId(s.id);
    setRenameInput(s.title);
  };

  const commitRename = () => {
    const t = renameInput.trim();
    if (t && renamingId) {
      setSessions((prev) =>
        prev.map((s) => (s.id === renamingId ? { ...s, title: t } : s))
      );
    }
    setRenamingId(null);
    setRenameInput("");
  };

  // 最近一次聊天内容+历史快照（超时/失败后「重试」复用，不重复追加用户消息）
  const lastChatRef = useRef<{ text: string; history: Message[] } | null>(null);
  // 重试失败反馈戳递增器（见 Message.flashNonce）
  const retryFlashRef = useRef(0);

  const runChat = async (history: Message[]) => {
    // 本轮生效的领域：
    // - 空选（默认）→ 不锁定领域，单纯呈现所有平台 top 热点（后端仍会打热点标签）
    // - 选了 1~MAX_DOMAINS 个 → 把所选领域【逐个】传给后端，按领域过滤 + 近30天兜底
    const domainStr = selectedDomains.join("、");

    // 2 分钟无响应判定为超时：手机网络/上游卡死时用户不再无限干等（重试即可重发）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    // 把用户为(生效)自创领域填写的释义一并传给后端，用于精确判定
    const glossary: Record<string, string> = {};
    for (const d of selectedDomains) {
      const note = domainNotes[d];
      if (note && note.trim()) glossary[d] = note.trim();
    }
    // 上一轮结构邮戳：取历史里最近一条【成功的】助手消息（失败卡片不携带）
    const prevTurnType = [...history]
      .reverse()
      .find((m) => m.role === "assistant" && !m.failed)?.turnType;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          domain: domainStr,
          platforms: selectedPlatforms,
          glossary,
          allDomains: domainOptions,
          llm: llmPayload(),
          ...(prevTurnType ? { lastTurnType: prevTurnType } : {}),
        }),
      });
      if (!res.ok) {
        // 非 2xx 也要把 body 读出来：LLM 配置类错误（无 Key/Key 无效/欠费/限流）
        // 会带 llmError 结构化引导，前端据此渲染「配置 Key / 去充值直达」按钮
        const errBody = await res.json().catch(() => null);
        const err = new Error(
          errBody?.error || errBody?.content || `HTTP ${res.status}`
        ) as Error & { llmError?: LlmErrorAction | null };
        err.llmError = errBody?.llmError ?? null;
        throw err;
      }
      const data = await res.json();
      // 累积本轮返回的「标题 → 原文链接」映射，供后续点详情时置顶主报道为核心来源
      if (data.topicUrls && typeof data.topicUrls === "object") {
        setTopicUrlMap((prev) => ({ ...prev, ...data.topicUrls }));
      }
      // 气泡领域标签：以服务端判定的本轮生效领域为准（消息点名 > 右上角；普通聊天/全量热榜无标签）
      const turnDomains: string[] = Array.isArray(data.turnDomains)
        ? data.turnDomains.map((x: unknown) => String(x).trim()).filter(Boolean)
        : [];
      if (turnDomains.length) {
        setActiveMessages((prev) => {
          let lastUserIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          if (lastUserIdx < 0) return prev;
          return prev.map((m, i) =>
            i === lastUserIdx ? { ...m, domains: turnDomains } : m
          );
        });
      }
      const turnType: Message["turnType"] =
        data.turnType === "hotboard" ||
        data.turnType === "overview" ||
        data.turnType === "other"
          ? data.turnType
          : undefined;
      // 本轮全网搜索参考来源（服务端 refs 结构化下发）：清洗成 RefSite[] 后随消息持久化
      let refs: Message["refs"];
      if (data.refs && typeof data.refs === "object") {
        const norm = (arr: unknown): RefSite[] =>
          Array.isArray(arr)
            ? arr
                .map((x): RefSite | null => {
                  if (!x || typeof x !== "object") return null;
                  const o = x as Record<string, unknown>;
                  const url = typeof o.u === "string" ? o.u.trim() : "";
                  if (!url) return null;
                  return {
                    url,
                    title:
                      typeof o.t === "string" && o.t.trim()
                        ? o.t.trim()
                        : url,
                    source: typeof o.s === "string" ? o.s : undefined,
                    date: typeof o.d === "string" ? o.d : undefined,
                  };
                })
                .filter((x): x is RefSite => !!x)
            : [];
        const all = norm((data.refs as { sites?: unknown[] }).sites);
        // 兼容：旧/异常下发没分组时按 URL 自行拆分网站/视频
        const sites =
          Array.isArray((data.refs as { videos?: unknown[] }).videos)
            ? all
            : all.filter((r) => !VIDEO_URL_RE.test(r.url));
        const videos = Array.isArray((data.refs as { videos?: unknown[] }).videos)
          ? norm((data.refs as { videos: unknown[] }).videos)
          : all.filter((r) => VIDEO_URL_RE.test(r.url));
        if (sites.length || videos.length) refs = { sites, videos };
      }
      setActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "抱歉，出了点问题。",
          toolLogs: data.toolLogs,
          emptyNote: data.emptyNote || undefined,
          ...(turnType ? { turnType } : {}),
          ...(refs ? { refs } : {}),
        },
      ]);
      return true;
    } catch (e) {
      // 超时（AbortError）与网络错误都给「失败卡片 + 重试」，不让用户对着空屏发懵；
      // LLM 配置类错误（无 Key/Key 无效/欠费）卡片上额外给「配置 Key / 去充值直达」按钮
      const aborted = (e as { name?: string })?.name === "AbortError";
      const le = (e as { llmError?: LlmErrorAction | null })?.llmError ?? null;
      setActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          failed: true,
          content: le
            ? le.message
            : aborted
            ? "这次请求超过 2 分钟没有返回，已自动停止。可能是网络不稳或服务繁忙。"
            : "这次请求没发成功，可能是网络不稳或服务繁忙。",
          llmError: le,
        },
      ]);
      return false;
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  const sendMessage = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput("");

    const userMsg: Message = {
      role: "user",
      content: msg,
      // 气泡领域标签由服务端判定后回填（抓热点时才有；标签=本轮实际生效领域）
    };
    const history: Message[] = [...messages, userMsg];
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeId) return s;
        const isFirstUser = !s.messages.some((m) => m.role === "user");
        return {
          ...s,
          title: isFirstUser ? msg.slice(0, 20) : s.title,
          messages: [...s.messages, userMsg],
        };
      })
    );
    setLoading(true);
    lastChatRef.current = { text: msg, history };
    await runChat(history);
  };

  // 失败重试：去掉末尾失败气泡，用原历史原样重发（用户消息不重复入栈）。
  // 反馈链路：点击瞬间按钮变转圈（至少转 420ms，防止没配 Key 时服务端几十毫秒
  // 秒拒、用户完全感知不到"试过了"）→ 成功则正常出内容；仍失败（没配 Key/
  // Key 无效/欠费/网络）新卡片红框左右抖一下，明确告诉用户"又试了一次，还是不行"。
  const retryChat = async () => {
    if (loading || retrying) return;
    // 正常流程 lastChatRef 有快照；页面刷新后 ref 会丢（会话从 localStorage 恢复，
    // 失败卡还在但内存快照没了）：从消息历史重建，取最后一条用户消息及其之前的对话，
    // 否则刷新后点重试会"毫无反应"。
    let last = lastChatRef.current;
    if (!last) {
      let idx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        last = {
          text: messages[idx].content,
          history: messages.slice(0, idx + 1),
        };
        lastChatRef.current = last;
      }
    }
    if (!last) return;
    setActiveMessages((prev) => {
      const arr = [...prev];
      const lastM = arr[arr.length - 1];
      if (lastM && lastM.role === "assistant" && lastM.failed) arr.pop();
      return arr;
    });
    setRetrying(true);
    setLoading(true);
    const startedAt = Date.now();
    const ok = await runChat(last.history);
    // 最短反馈时长：秒拒场景下补足转圈展示时间
    const elapsed = Date.now() - startedAt;
    if (elapsed < 420) {
      await new Promise((r) => setTimeout(r, 420 - elapsed));
    }
    setRetrying(false);
    if (!ok) {
      // 戳 +1 并写进卡片 key：强制该卡以带红抖 class 的新节点重挂载，动画每次必播
      retryFlashRef.current += 1;
      const nonce = retryFlashRef.current;
      setActiveMessages((prev) => {
        const arr = [...prev];
        const lastM = arr[arr.length - 1];
        if (lastM && lastM.role === "assistant" && lastM.failed) {
          arr[arr.length - 1] = { ...lastM, flashNonce: nonce };
        }
        return arr;
      });
    }
  };

  // LLM 配置类失败的引导按钮组（只渲染按钮本身，由调用方决定排列容器）：
  // - 没配 Key / Key 无效 → 一键打开「AI 模型设置」弹窗（旁边附申请 Key 直达链接）
  // - 余额不足 → 绿色主按钮直达对应平台充值页（不是平台首页，是充值页），可另选更换 Key
  // - 限流 / 上游故障 → 无专属按钮，靠调用方自带的「重试 / 刷新重试」
  // 统一顺序：重试类按钮在【最左】，引导主按钮在【最右】；调用方把容器设为右对齐。
  const renderLlmActionButtons = (
    le: LlmErrorAction | null | undefined,
    opts?: { retry?: () => void; retryLabel?: string }
  ) => {
    if (!le) return null;
    const base =
      "inline-flex items-center gap-1 rounded-full text-xs font-medium px-3 py-1 transition disabled:opacity-50 whitespace-nowrap";
    const primary = `${base} bg-indigo-500 text-white hover:bg-indigo-600`;
    const ghost = `${base} bg-indigo-50 text-indigo-600 hover:bg-indigo-100`;
    const pay = `${base} bg-emerald-500 text-white hover:bg-emerald-600`;
    return (
      <>
        {opts?.retry && (
          <button className={ghost} onClick={opts.retry} disabled={loading}>
            {retrying ? (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
            )}
            {retrying ? "重试中…" : opts.retryLabel || "重试"}
          </button>
        )}
        {le.kind === "invalid_key" && le.keyUrl && (
          <a
            className={ghost}
            href={le.keyUrl}
            target="_blank"
            rel="noreferrer"
          >
            去申请新 Key
          </a>
        )}
        {le.kind === "no_balance" && (
          <button className={ghost} onClick={() => setShowLlm(true)}>
            更换别的 Key
          </button>
        )}
        {(le.kind === "no_key" || le.kind === "invalid_key") && (
          <button className={primary} onClick={() => setShowLlm(true)}>
            {le.kind === "no_key" ? "⚙️ 配置 API Key" : "🔑 检查 / 更换 Key"}
          </button>
        )}
        {le.kind === "no_balance" && le.topupUrl && (
          <a className={pay} href={le.topupUrl} target="_blank" rel="noreferrer">
            💰 去{le.providerName}充值（直达充值页）
          </a>
        )}
      </>
    );
  };

  const renderDomainChips = (autoFocusInput = false) => {
    void autoFocusInput;
    // 选中的领域前置、未选的沉到后面；各组内部保持 domainOptions 原始顺序（组内稳定，避免同组乱跳）。
    const ordered = [
      ...domainOptions.filter((d) => selectedDomains.includes(d)),
      ...domainOptions.filter((d) => !selectedDomains.includes(d)),
    ];
    return (
      <div className="flex flex-wrap gap-2 items-center">
        {ordered.map((d) => {
          const active = selectedDomains.includes(d);
          const custom = !DOMAINS.includes(d);
          return (
            <button
              key={d}
              onClick={() => toggleDomain(d)}
              title={domainNotes[d] || undefined}
              className={`px-3 py-1 rounded-full text-xs border transition flex items-center gap-1 ${
                active
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-700 border-gray-300 hover:border-indigo-300"
              }`}
            >
              <span>{d}</span>
              {custom && (
                <span
                  role="button"
                  title="编辑自定义领域"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditDomain(d);
                  }}
                  className={`ml-0.5 leading-none ${
                    active
                      ? "text-white/80 hover:text-white"
                      : "text-gray-500 hover:text-indigo-600"
                  }`}
                >
                  ✎
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={openAddDomain}
          className="px-3 py-1 rounded-full text-xs border border-dashed border-gray-400 text-gray-500 hover:border-indigo-400 hover:text-indigo-500 transition"
        >
          ＋ 添加
        </button>
      </div>
    );
  };

  // 顶部平台区：与「关注领域」同层级（无外框卡片）。胶囊只读展示，点胶囊或「编辑」打开选择弹窗
  const renderPlatformEntry = () => {
    const ordered = PLATFORMS.filter((p) => selectedPlatforms.includes(p));
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-600">
            抓取平台
            <span className="text-gray-400">
              （已选 {selectedPlatforms.length}/{MAX_PLATFORMS}）
            </span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={openPlatformPicker}
              className="text-xs text-gray-500 hover:text-indigo-600 transition"
            >
              编辑
            </button>
          </div>
        </div>
        {ordered.length > 0 ? (
          <div className="flex flex-wrap gap-2 items-center">
            {ordered.map((p) => (
              <button
                key={p}
                onClick={openPlatformPicker}
                title="点击管理抓取平台"
                className="px-3 py-1 rounded-full text-xs border transition flex items-center gap-1.5 bg-indigo-600 text-white border-indigo-600"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                {p}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-400">
            暂未选择平台，点「编辑」添加（至少选 1 个）
          </div>
        )}
      </div>
    );
  };

  // 弹窗内的平台胶囊（上块/下块共用渲染）：draftMode 决定点击行为
  const renderPickerChip = (p: string, picked: boolean) => {
    const c = PLATFORM_COLORS[p] || {
      hover: "hover:border-indigo-400 hover:text-indigo-500",
      dot: "bg-indigo-500",
    };
    const full = !picked && draftPlatforms.length >= MAX_PLATFORMS;
    return (
      <button
        key={p}
        disabled={full}
        onClick={() => (picked ? removeDraftPlatform(p) : addDraftPlatform(p))}
        title={
          picked
            ? "点击移除"
            : full
            ? `最多选 ${MAX_PLATFORMS} 个，先移除一个再添加`
            : "点击添加"
        }
        className={`px-3 py-1 rounded-full text-xs border transition flex items-center gap-1.5 ${
          picked
            ? "bg-indigo-600 border-indigo-600 text-white"
            : full
            ? "bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed"
            : `bg-white text-gray-600 border-gray-300 ${c.hover}`
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            picked ? "bg-white/90" : full ? "bg-gray-300" : c.dot
          }`}
        />
        {p}
      </button>
    );
  };

  // 区块标题（左侧标签 + 右上角 清空）。领域最多选 MAX_DOMAINS 个，故不再提供「全选」
  const renderDomainHeader = () => (
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs font-medium text-gray-600">
        关注领域<span className="text-gray-400">（不选=全部热点，最多选 {MAX_DOMAINS} 个）</span>
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={clearDomains}
          className="text-xs text-gray-500 hover:text-indigo-600 transition"
        >
          清空
        </button>
      </div>
    </div>
  );

  // （平台区头部已并入 renderPlatformEntry 的入口行；清空/全选移入平台选择弹窗）

  // 去掉多余的 Markdown 符号（行首 #/##/### 标题符号、** 加粗、* 强调）后再展示
  const cleanMarkdown = (text: string) =>
    text
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/\*+/g, "");

  // 把一行文字里的 【xxx】 渲染成跑道圆形胶囊
  const renderLineWithTags = (text: string, keyPrefix: string) => {
    const parts = text.split(/(【[^】]*】)/g);
    return parts.map((part, idx) => {
      const m = part.match(/^【([^】]*)】$/);
      if (m) {
        // 兜底：模型有时把多个领域塞进同一个【】（如「女性成长、反bl」），
        // 这里按顿号/逗号/斜杠拆开，一个领域渲染成一个独立胶囊。
        const tags = m[1]
          .split(/[、，,\/]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        return tags.map((tag, j) => (
          <span
            key={`${keyPrefix}-${idx}-${j}`}
            className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-600 text-[10px] leading-none px-1.5 py-0.5 mx-0.5 align-middle"
          >
            {tag}
          </span>
        ));
      }
      return <span key={`${keyPrefix}-${idx}`}>{part}</span>;
    });
  };

  // 把一行里的【xxx】整体抽出来（多个领域已按顿号/逗号拆好），正文去掉标签并压紧空格——
  // 供条目行「标签胶囊后置到标题后面、查看详情按钮前面」的渲染用
  const splitLineTags = (text: string) => {
    const tags: string[] = [];
    const body = text
      .replace(/【([^】]*)】/g, (_all, inner: string) => {
        inner
          .split(/[、，,\/]+/)
          .forEach((t) => {
            const x = t.trim();
            if (x) tags.push(x);
          });
        return "";
      })
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { tags, body };
  };

  // 去掉行首序号和 ⭐，得到"平台｜标题 【标签】"主体
  const stripLead = (line: string) =>
    line
      .replace(/^\s*\d+[.、)]\s*/, "")
      .replace(/⭐/g, "")
      .trim();

  // 从热点行里提取纯话题标题（去掉序号、⭐、"平台｜"前缀、【】标签、Markdown 符号）
  const extractTopic = (line: string) =>
    stripLead(line)
      .replace(/^[^｜|【\n]{1,10}[｜|]\s*/, "") // 去掉"平台｜"前缀（若有）
      .replace(/【[^】]*】/g, "")
      .replace(/[*#`]+/g, "")
      .trim();

  // 从热点行里提取平台（行格式为"序号. 平台｜标题 …"，取 ｜ 前的平台名）
  const extractPlatform = (line: string) => {
    const m = stripLead(line).match(/^([^｜|【\n]{1,10})[｜|]/);
    return m ? m[1].trim() : "";
  };

  // 从主体结构回复里提取核心主体名（供查看详情/生成脚本以"主体本身"为核心）。
  // 2026-09 事故修复：模型常不按格式把"【主体速览】"独占一行、下一行以
  // "已核实资料显示，bl（…）"开头，旧正则会把叙事残段"已核实资料显示"当成主体名，
  // 污染详情/脚本的全部检索词。统一走 lib 的容错提取（剥叙事前缀/识别英文词书名号/
  // 校验专名特征），拿不到可靠主体名返回 ""——后端空主体走概念检索，比错名安全。
  const extractEntityName = (content: string) =>
    extractEntityFromOverview(content);
  // 点击「查看详情」：首次拉取详情并展开，之后仅切换展开/收起（失败态也可正常展开收起，重试走独立按钮）
  // entity：主体结构的方向区条目会带上所属主体名，让详情接口围绕主体本身检索与成文
  const toggleDetail = async (
    key: string,
    topic: string,
    platform = "",
    url = "",
    entity = "",
    keywords: string[] = []
  ) => {
    const cur = details[key];
    if (cur && cur.data) {
      updateDetails((p) => ({ ...p, [key]: { ...cur, open: !cur.open } }));
      return;
    }
    if (cur && cur.loading) return;
    await loadDetail(key, topic, platform, url, entity, keywords);
  };

  // 实际拉取详情（首次点击与「重试」共用）：失败时置 error 标记，供 UI 显示重试按钮
  const loadDetail = async (
    key: string,
    topic: string,
    platform = "",
    url = "",
    entity = "",
    keywords: string[] = []
  ) => {
    updateDetails((p) => ({
      ...p,
      [key]: { open: true, loading: true, data: null },
    }));
    try {
      const res = await fetch("/api/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          platform,
          url,
          entity,
          keywords,
          llm: llmPayload(),
        }),
      });
      const data = (await res.json()) as DetailData;
      // 服务端 500 或返回"详情获取失败…"这类兜底文案，同样按失败处理，展示重试按钮
      const failed =
        !res.ok || /^详情获取失败/.test((data?.report || "").trim());
      updateDetails((p) => ({
        ...p,
        [key]: { open: true, loading: false, data, error: failed },
      }));
    } catch (e) {
      console.warn("[ui] 详情获取请求失败，展示重试卡:", e);
      updateDetails((p) => ({
        ...p,
        [key]: {
          open: true,
          loading: false,
          data: { report: "详情获取失败，请稍后重试。", sites: [], videos: [] },
          error: true,
        },
      }));
    }
  };

  // ========== 消息多选删除 ==========
  const isWelcomeMsg = (i: number) => messages[i]?.content === WELCOME.content;

  // 触发删除的那条，连同配对的问/答一起自动选中：
  // 点在「回答」上→带上上一条「提问」；点在「提问」上→带上下一条「回答」。欢迎语不参与。
  const pairIndicesFor = (i: number): number[] => {
    const msg = messages[i];
    if (!msg) return [];
    const res = [i];
    if (msg.role === "assistant") {
      if (i - 1 >= 0 && messages[i - 1].role === "user") res.push(i - 1);
    } else if (i + 1 < messages.length && messages[i + 1].role === "assistant") {
      res.push(i + 1);
    }
    return res.filter((idx) => !isWelcomeMsg(idx));
  };

  const enterSelectMode = (i: number) => {
    setSelectMode(true);
    setSelectedMsgs(pairIndicesFor(i));
  };

  const toggleSelect = (i: number) => {
    if (isWelcomeMsg(i)) return;
    setSelectedMsgs((prev) =>
      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
    );
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedMsgs([]);
  };

  const deleteSelected = () => {
    if (selectedMsgs.length === 0) return;
    const del = new Set(selectedMsgs);
    setActiveMessages((prev) => prev.filter((_, idx) => !del.has(idx)));
    updateDetails(() => ({})); // 删除后序号会平移，清空本会话详情缓存避免 key 错位
    exitSelectMode();
  };

  const copyMessage = async (content: string, idx: number) => {
    // 复制给用户的文本不带 %%REFS%% 机器标记（那是给前端渲染折叠块用的）
    const text = content
      .split("\n")
      .filter((l) => !l.trim().startsWith(REFS_PREFIX))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      // 常见于非安全上下文(http://IP)或用户拒绝授权：下面有 execCommand 回退，这里只留 debug
      console.debug("[ui] Clipboard API 复制失败，尝试 execCommand 回退:", e);
    }
    if (!ok) {
      // 回退：非安全上下文(如 http://IP)下 navigator.clipboard 不可用，用临时 textarea + execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) {
        console.warn("[ui] execCommand 复制回退也失败了:", e);
      }
    }
    if (ok) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    }
  };

  // 移动端长按唤起编辑态（600ms，主流区间：安卓系统400ms/微信500-700ms，取稳不取快）；
  // 滑动/松手/系统接管(touchcancel)均取消计时。
  // 多指起手(≥2触点)不唤起：三指下滑截屏等系统手势的幻影触摸不应进多选删除。
  const startLongPress = (i: number, e: React.TouchEvent) => {
    if (isWelcomeMsg(i) || selectMode) return;
    if (e.touches.length > 1) {
      cancelLongPress();
      return;
    }
    longPressTimer.current = setTimeout(() => enterSelectMode(i), 600);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // ── 热榜速报的「平台聚合 / 领域聚合」切换（2026-09）──
  // 服务端确定性速报形态："🔥 平台 今日热榜" 分节 + "N. 标题 【领域标签】" 条目。
  // 解析出分节与条目模型；仅当≥2个平台分节且条目上出现≥2个不同领域标签时才算"可切换"。
  // 实体对照块（"🔥 今日热榜相关"，条目带"平台｜"前缀）只有单节且无领域标签，天然不入选。
  interface HotBoardItem {
    li: number;
    platform: string;
    title: string;
    tags: string[];
  }
  interface HotBoardSection {
    name: string;
    startLi: number;
    items: HotBoardItem[];
  }
  interface HotBoardModel {
    startLi: number;
    endLi: number;
    sections: HotBoardSection[];
  }
  const extractBracketTags = (s: string): string[] => {
    const tags: string[] = [];
    s.replace(/【([^】]*)】/g, (_m, inner: string) => {
      inner.split(/[、，,\/]+/).forEach((t) => {
        const x = t.trim();
        if (x) tags.push(x);
      });
      return "";
    });
    return tags;
  };
  const parseHotBoard = (lines: string[]): HotBoardModel | null => {
    const sections: HotBoardSection[] = [];
    let cur: HotBoardSection | null = null;
    lines.forEach((line, li) => {
      const sec = line.match(/^🔥\s*(.+?)(?:\s*(?:今日热点|今日热榜))?\s*$/);
      if (sec) {
        cur = { name: sec[1].trim(), startLi: li, items: [] };
        sections.push(cur);
        return;
      }
      const m = line.match(/^\s*\d+[.、)]\s+(.+)$/);
      if (cur && m) {
        const body = m[1];
        // 实体对照块条目是"平台｜标题"形态，不属于全平台聚合速报
        if (/^[^｜|【\n]{1,10}[｜|]/.test(body.trim())) return;
        cur.items.push({
          li,
          platform: cur.name,
          title: body.replace(/【[^】]*】/g, "").replace(/[*#`]+/g, "").trim(),
          tags: extractBracketTags(body),
        });
        return;
      }
      // 实心非条目行（提示语/分隔等）结束当前分节；空行允许跨过分节间隔
      if (line.trim() !== "") cur = null;
    });
    const valid = sections.filter((s) => s.items.length > 0);
    if (valid.length < 2) return null;
    const tagSet = new Set<string>();
    valid.forEach((s) => s.items.forEach((it) => it.tags.forEach((t) => tagSet.add(t))));
    if (tagSet.size < 2) return null;
    const lastSec = valid[valid.length - 1];
    return {
      startLi: valid[0].startLi,
      endLi: lastSec.items[lastSec.items.length - 1].li,
      sections: valid,
    };
  };

  // 领域聚合视图：把条目按【首次出现顺序】的领域重组——多标签条目在各领域下各出现一次；
  // 无标签条目归入末尾"未分类"。行内胶囊换成平台名，平台信息同时走 side-channel，
  // 保证「查看详情」拿到的 platform 仍是真实平台（不会被当前领域分节名污染）。
  interface BoardVLine {
    text: string;
    origLi: number;
    platform?: string;
    toggleHere?: boolean;
  }
  const buildDomainView = (lines: string[], board: HotBoardModel): BoardVLine[] => {
    const out: BoardVLine[] = [];
    for (let li = 0; li < board.startLi; li++) {
      out.push({ text: lines[li], origLi: li });
    }
    const order: string[] = [];
    const groups = new Map<string, HotBoardItem[]>();
    const untagged: HotBoardItem[] = [];
    board.sections.forEach((s) =>
      s.items.forEach((it) => {
        if (it.tags.length === 0) {
          untagged.push(it);
          return;
        }
        it.tags.forEach((t) => {
          let g = groups.get(t);
          if (!g) {
            g = [];
            groups.set(t, g);
            order.push(t);
          }
          g.push(it);
        });
      })
    );
    let first = true;
    const pushGroup = (name: string, items: HotBoardItem[]) => {
      out.push({ text: `🔥 ${name} 今日热榜`, origLi: board.startLi, toggleHere: first });
      first = false;
      items.forEach((it, idx) => {
        out.push({ text: `${idx + 1}. ${it.title} 【${it.platform}】`, origLi: it.li, platform: it.platform });
      });
      out.push({ text: "", origLi: -1 });
    };
    order.forEach((name) => pushGroup(name, groups.get(name)!));
    if (untagged.length) pushGroup("未分类", untagged);
    for (let li = board.endLi + 1; li < lines.length; li++) {
      out.push({ text: lines[li], origLi: li });
    }
    return out;
  };

  // 平台/领域聚合切换的小分段控件（右对齐放在速报分节正上方，常驻可见、不依赖 hover）
  const renderBoardSwitch = (boardKey: string) => {
    const on = !!boardDomainView[boardKey];
    const seg = (label: string, active: boolean, val: boolean) => (
      <button
        type="button"
        onClick={() => setBoardDomainView((p) => ({ ...p, [boardKey]: val }))}
        className={`px-2.5 py-1 rounded-full transition whitespace-nowrap ${
          active
            ? "bg-white text-indigo-600 shadow-sm font-medium"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        {label}
      </button>
    );
    return (
      <div className="mb-1.5 mt-2 flex justify-end">
        <div className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100/80 p-0.5 text-[11px] leading-none select-none">
          {seg("按平台聚合", !on, false)}
          {seg("按领域聚合", on, true)}
        </div>
      </div>
    );
  };

  // 渲染 AI 正文：逐行解析，热点条目支持 hover「查看详情」原地展开。
  // extraRefs = 服务端结构化下发的本消息参考来源（新链路），与正文 %%REFS%% 历史标记
  // 一样提到整条回复【最前面】，默认完全收起（外层小结果，不做"只露3条"）。
  const renderAssistantContent = (
    content: string,
    msgIndex: number,
    extraRefs?: Message["refs"]
  ) => {
    // 模型偶发漏换行把【主体速览】接在【热榜速报】同一行：渲染前强制断行，
    // 防止速报灰条把正文整段吞进去（历史消息同样生效）
    const rawLines = content
      .replace(/(【热榜速报】[^\n]*?)\s*【主体速览】/g, "$1\n【主体速览】")
      .split("\n");
    // 参考来源前置（2026-09）：%%REFS%% 机器标记通常被后端追加在正文末尾（主体不在热榜、
    // 走全网检索兜底时最常见）。用户希望先看到"料从哪来"再读正文——这里把标记行从正文里
    // 抽出来，统一提到整条回复【最前面】，用现成折叠壳渲染、默认收起。
    const topRefs: { sites: RefSite[]; videos: RefSite[] }[] = [];
    // "今日各平台实时热榜暂无…"系统提示行：抽离正文，统一在【参考网站/视频块上方】
    // 渲染成整条全宽、左对齐的灰条（与参考块同宽），不再混在正文散文里。
    const noticeBars: string[] = [];
    const noticeSeen = new Set<string>();
    // 两种"今日暂无"提示统一抽离：①兜底句"今日各平台实时热榜暂无「X」…"；
    // ②主体热榜块的"【热榜速报】今日各平台热榜暂无「X」…"。同一主体只保留第一条，
    // 避免同屏两条意思重复的提示。统一在参考块上方渲染成全宽、左对齐灰条。
    const NOTICE_BAR_RE =
      /^(?:【热榜速报】\s*|📌\s*)?今日各平台(?:实时)?热榜暂无/;
    const lines = rawLines.filter((l) => {
      const t = l.trim();
      if (NOTICE_BAR_RE.test(t)) {
        const clean = t
          .replace(/^(?:【热榜速报】\s*|📌\s*)/, "")
          .trim();
        const key = (clean.match(/今日各平台(?:实时)?热榜暂无(「[^」]+」)?/)?.[1]) || clean;
        if (!noticeSeen.has(key)) {
          noticeSeen.add(key);
          noticeBars.push(clean);
        }
        return false;
      }
      if (!t.startsWith(REFS_PREFIX)) return true;
      try {
        const raw: unknown = JSON.parse(t.slice(REFS_PREFIX.length));
        if (Array.isArray(raw)) {
          const all: RefSite[] = raw
            .map((x): RefSite | null => {
              if (!x || typeof x !== "object") return null;
              const o = x as Record<string, unknown>;
              const url = typeof o.u === "string" ? o.u.trim() : "";
              if (!url) return null;
              return {
                url,
                title:
                  typeof o.t === "string" && o.t.trim() ? o.t.trim() : url,
                source: typeof o.s === "string" ? o.s : undefined,
                date: typeof o.d === "string" ? o.d : undefined,
                search: true,
              };
            })
            .filter((x): x is RefSite => !!x);
          if (all.length) {
            topRefs.push({
              sites: all.filter((r) => !VIDEO_URL_RE.test(r.url)),
              videos: all.filter((r) => VIDEO_URL_RE.test(r.url)),
            });
          }
        }
      } catch {
        // 标记损坏：静默丢弃该行（下方正文同样会隐藏），绝不把 JSON 抛给用户
      }
      return false;
    });
    // 结构化 refs（新链路）放在置顶卡第一组；历史 %%REFS%% 标记组紧随其后
    if (extraRefs && (extraRefs.sites.length > 0 || extraRefs.videos.length > 0)) {
      topRefs.unshift({ sites: extraRefs.sites, videos: extraRefs.videos });
    }
    // 兜底网页文章（"序号. [日期] 域名｜标题"）→ 用参考网站 refs 把标题还原成可点链接：
    // 只认｜前是域名样式（含点号，如 thepaper.cn）的行，今日热榜的"平台｜"行绝不在此列。
    const allRefSites = topRefs.flatMap((b) => b.sites);
    const normRefTitle = (s: string) =>
      (s || "")
        .replace(/\s+/g, "")
        .replace(/[*_#`>【】（）()\[\]]/g, "")
        .toLowerCase();
    const matchRefArticle = (
      line: string
    ): { url: string; no: string; date: string; src: string; title: string } | null => {
      const m = line
        .trim()
        .match(/^(\d+[.、)])\s*(?:\[([\d-]+)\]\s*)?([^｜|]{1,20}?)[｜|]\s*(.+)$/);
      if (!m) return null;
      const [, no, date, src, rawTitle] = m;
      if (!/\.[a-z]{2,}/i.test(src)) return null;
      const want = normRefTitle(rawTitle);
      if (want.length < 4) return null;
      const hit = allRefSites.find((s) => {
        const st = normRefTitle(s.title);
        return !!st && (st.includes(want) || want.includes(st));
      });
      if (!hit) return null;
      return {
        url: hit.url,
        no,
        date: date || "",
        src: src.trim(),
        title: rawTitle.trim(),
      };
    };
    // 主体结构回复的核心主体名（【主体速览】行），方向区条目的查看详情/生成脚本都以它为核心
    const entityName = extractEntityName(content);
    let curSection = "";
    // 方向区上下文：正文出现「直接相关的切入 / 相关领域的切入」标题后，其下的"- "
    // 条目视为建议条目，挂与热搜条目相同的「查看详情→口播素材/关联文章→生成脚本」链路
    // （"特质衍生的切入"已并入直接相关的切入，保留识别是为了兼容历史消息）
    let dirSection = "";
    // 热榜聚合模型：可切换（≥2平台分节+≥2领域标签）时，按本消息的开关状态决定虚拟行序列。
    // 平台视图=原文行（恒等映射）；领域视图=重排后的虚拟行，详情展开 key 仍绑定原始行号 li。
    const board = parseHotBoard(lines);
    const boardKey = `${activeId}:${msgIndex}`;
    const domainOn = !!(board && boardDomainView[boardKey]);
    const vlist: BoardVLine[] =
      board && domainOn
        ? buildDomainView(lines, board)
        : lines.map((t, i) => ({ text: t, origLi: i }));
    const bodyNodes = vlist.map((v, vi) => {
      const line = v.text;
      const li = v.origLi;
      if (line.trim() === "") return <div key={vi} className="h-2" />;
      // %%REFS%% 标记已在函数入口统一抽取并置顶渲染，正常不会走到这里；防御性隐藏
      if (line.trim().startsWith(REFS_PREFIX)) {
        return <div key={vi} className="hidden" />;
      }
      // 分隔线：服务端在"热榜对照块"与"主体速览"之间输出的纯分隔字符行（────/———/等），
      // 渲染成一条细分隔线，让"今日热榜对照"与"全网资料整理"两块在视觉上明确断开。
      if (/^[─—\-_＝=﹉]{6,}$/.test(line.trim())) {
        return (
          <div key={vi} className="my-3 flex items-center" aria-hidden>
            <div className="h-px w-full bg-gradient-to-r from-transparent via-gray-300 to-transparent" />
          </div>
        );
      }
      // 热榜速报（1-2 条"结果较少"提示）：整条全宽、左对齐灰条；
      // "今日暂无"变体已在函数入口抽到参考块上方，不会走到这里。
      if (line.trim().startsWith("【热榜速报】")) {
        const note = cleanMarkdown(line.replace(/^【热榜速报】\s*/, "").trim());
        return (
          <div
            key={vi}
            className="my-2.5 w-full rounded-lg bg-gray-100 px-3 py-2 text-left text-xs leading-relaxed text-gray-500"
          >
            {note}
          </div>
        );
      }
      // 平台分节头："🔥 微博 今日热点/今日热榜" → 平台色圆点 + 加粗标题。
      // 若是可切换速报的第一个分节，在分节上方挂「按平台/按领域聚合」分段开关。
      const sec = line.match(/^🔥\s*(.+?)(?:\s*(?:今日热点|今日热榜))?\s*$/);
      if (sec) {
        curSection = sec[1].trim();
        const showSwitch =
          !!board && (domainOn ? !!v.toggleHere : li === board.startLi);
        return (
          <Fragment key={vi}>
            {showSwitch && renderBoardSwitch(boardKey)}
            <div className="mt-3 mb-1 flex items-center gap-1.5 first:mt-0">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  domainOn
                    ? "bg-emerald-500"
                    : PLATFORM_COLORS[curSection]?.dot || "bg-indigo-500"
                }`}
              />
              <span className="text-[15px] font-semibold text-gray-900">
                {curSection}
              </span>
            </div>
          </Fragment>
        );
      }
      // 方向区小节标题：加粗渲染并进入方向区上下文（cleanMarkdown 先剥掉模型可能自加的 **/#）
      const dirHdr = cleanMarkdown(line).trim().match(/^(直接相关的切入|相关领域的切入|特质衍生的切入)$/);
      if (dirHdr) {
        dirSection = dirHdr[1];
        return (
          <div
            key={vi}
            className="mt-3 mb-1 text-[15px] font-semibold text-gray-900"
          >
            {dirHdr[1]}
          </div>
        );
      }
      // 离开方向区：出现既非"- "条目也非标题的实心行（如结尾句/正文段）即重置
      if (dirSection && !/^\s*[-•]/.test(line)) dirSection = "";
      const isItem = /^\s*\d+[.、)]\s/.test(line);
      // 兜底网页文章行（域名｜标题 且 refs 里有对应链接）：标题直接渲染为可点开的新标签链接，
      // 不走"查看详情"热榜条目链路——它本来就是给用户点开看的外部文章。
      const refArticle = isItem ? matchRefArticle(line) : null;
      if (refArticle) {
        return (
          <div key={vi} className="text-[15px] leading-relaxed text-gray-800">
            <span className="mr-1 text-gray-400">{refArticle.no}</span>
            {refArticle.date && (
              <span className="mr-1 text-gray-400">[{refArticle.date}]</span>
            )}
            <span className="text-gray-500">{refArticle.src}｜</span>
            <a
              href={refArticle.url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-words text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
            >
              {refArticle.title}
            </a>
          </div>
        );
      }
      // 方向区下的"- "建议条目
      const dirBullet = dirSection !== "" && /^\s*[-•]\s*/.test(line);
      const capsuleChip = /【[^】]+】/.test(line);
      // 编号行只有在像热点条目时才挂「查看详情」：有 🔥 分节上下文 / 平台｜前缀 / 【标签】之一。
      // 否则模型聊天回复里的普通编号解释句（如"1. 我系统锁定的可用领域只有…"）也会被误挂按钮。
      const looksLikeHotItem =
        isItem &&
        (curSection !== "" ||
          /^[^｜|【\n]{1,10}[｜|]/.test(stripLead(line)) ||
          capsuleChip);
      // 行尾检索契约（2026-09）：角度行尾的 〔搜：词1 词2 词3〕 是模型按 prompt 输出的
      // 机器标记，正常正文不会出现。模型实测约 1/3 概率漏写「直接相关的切入」小节标题，
      // dirSection 状态机进不去——故先在原文上探一遍契约，作为第三条建议条目识别路径。
      const hasAngleContract = parseAngleMarker(line).keywords.length > 0;
      // 建议条目（方向区"- "行 / 带【领域】胶囊的行 / 带〔搜：〕契约的角度行）：与热搜条目走
      // 同一条 查看详情→口播素材/关联文章→生成脚本 链路；检索词优先取契约词，否则整句
      const suggestionItem =
        !looksLikeHotItem &&
        (dirBullet || capsuleChip || hasAngleContract);
      // 方向区条目行的 emoji（🔥💰⚡ 等）是模型惯性加的装饰，与领域胶囊混在一起显得莫名其妙——
      // 渲染前确定性剥掉（提示词禁令对模型抑制不稳定，前端兜底；漏标题的契约孤儿条目同属角度行，
      // 一并剥；热搜条目标题不动）
      const strippedLine =
        dirBullet || hasAngleContract
          ? line
              .replace(
                /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu,
                ""
              )
              .replace(/[ \t]{2,}/g, " ")
              .trimEnd()
          : line;
      // 显式检索契约（2026-09）：〔搜：…〕绝不能显示给用户，也不能带着它去检索——
      // 这里剥成展示文本 + 检索词两部分。
      const angleMarker = parseAngleMarker(strippedLine);
      const displayLine = angleMarker.display;
      let tagTopic = "";
      let tagKeywords: string[] = angleMarker.keywords;
      if (suggestionItem) {
        const baseTopic = stripAngleLead(
          stripLead(cleanMarkdown(displayLine))
            .replace(/【[^】]*】/g, "")
            .replace(/^\s*-\s*/, "")
            .replace(/[；;。，,]\s*$/, "")
        );
        if (tagKeywords.length) {
          // 契约路径：检索词显式随请求发出（后端 core/fan-out/事实门都用它们）；
          // topic 仍传剥壳整句——后端排序与成文需要整句锚点，检索不直接用它。
          tagTopic = baseTopic;
        } else {
          // 旧消息兜底：引号短语全收——除了 ≥5 字的长引句，2-3 字圈内黑话原词
          //（蔑称/外号）也要逐词带给后端 fan-out，不能再因太短被整句长查询埋没。
          const allQuoted = heuristicAngleKeywords(displayLine);
          const longQuoted = allQuoted.find((q) => q.length >= 5);
          tagTopic = longQuoted || baseTopic;
          tagKeywords = allQuoted.filter(
            (q) => q.replace(/\s+/g, "") !== tagTopic.replace(/\s+/g, "")
          );
        }
        tagTopic = tagTopic.replace(/[*#`]+/g, "").trim().slice(0, 60);
      }
      if (!looksLikeHotItem && !(suggestionItem && tagTopic.length >= 4)) {
        return (
          <div key={vi} className="group whitespace-pre-wrap">
            {renderLineWithTags(cleanMarkdown(displayLine), `${msgIndex}-${li}`)}
          </div>
        );
      }
      const topic = suggestionItem ? tagTopic : extractTopic(line);
      // 领域聚合视图下平台走虚拟行 side-channel（此时 curSection 是领域名，不能兜底用它）
      const platform = suggestionItem
        ? ""
        : v.platform || extractPlatform(line) || curSection;
      const url = suggestionItem ? "" : topicUrlMap[topic] || "";
      const key = `${msgIndex}:${li}`;
      const st = details[key];
      // 胶囊位置分流：热搜条目后置（标题→胶囊→查看详情按钮）；方向区/建议条目前置
      // （胶囊→标题，恢复原布局）。点击查看详情后的卡片内不渲染行内胶囊，不受影响。
      const { tags: rowTags, body: rowBody } = splitLineTags(
        cleanMarkdown(displayLine)
      );
      const tagSpans = (cls: string) =>
        rowTags.map((tag, j) => (
          <span
            key={`${key}-tag-${j}`}
            className={`inline-flex items-center rounded-full bg-emerald-50 text-emerald-600 text-[10px] leading-none px-1.5 py-0.5 ${cls} align-middle whitespace-nowrap`}
          >
            {tag}
          </span>
        ));
      return (
        <div
          key={vi}
          className={
            suggestionItem
              ? "group whitespace-pre-wrap"
              : // 悬浮阴影只在桌面端（sm+）出现且做柔和（靛蓝低透明度大模糊）；
                // 手机端彻底去掉 hover 阴影/底色——触屏没有真实 hover，点按后还会残留
                "group rounded-lg px-1.5 -mx-1.5 py-0.5 transition-colors sm:hover:bg-white/70 sm:hover:shadow-[0_4px_16px_-6px_rgba(79,70,229,0.16)]"
          }
        >
          <div className="whitespace-pre-wrap">
            {suggestionItem && tagSpans("mr-1.5")}
            {rowBody}
            {!suggestionItem && tagSpans("ml-1.5")}
            <button
              onClick={() =>
                toggleDetail(
                  key,
                  topic,
                  platform,
                  url,
                  suggestionItem ? entityName : "",
                  suggestionItem ? tagKeywords : []
                )
              }
              className={`align-middle ml-2 whitespace-nowrap text-[11px] leading-none px-2 py-1 rounded-full border transition ${
                st
                  ? "opacity-100 border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                  : "border-indigo-300 text-indigo-600 hover:bg-indigo-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              }`}
            >
              {st?.open ? "收起" : st ? "展开" : "查看详情"}
            </button>
            {/* 查看过详情后，展开/收起按钮右侧常驻「生成脚本」入口。
                事实门闸住（needClarify）时不展示——此时 report 只是"没查到"提示语，
                放它进写稿链路只会产出无依据成稿（后端也会再兜底检索，双保险）。 */}
            {st?.data && !st.data.needClarify && (
              <button
                onClick={() =>
                  openScriptModal(
                    topic,
                    platform,
                    st.data?.report || "",
                    st.data?.material,
                    suggestionItem ? entityName : "",
                    st.data?.sites
                  )
                }
                className="align-middle ml-2 whitespace-nowrap text-[11px] leading-none px-2 py-1 rounded-full border border-indigo-300 text-indigo-600 hover:bg-indigo-50 transition"
              >
                生成脚本
              </button>
            )}
          </div>
          {st?.open && (
            <div
              className={
                st.loading
                  ? // 加载态：只保留一个蓝色提示框，不再嵌套灰色外框（蓝框占满原灰框全宽）
                    "mt-2 mb-2 text-xs"
                  : "mt-2 mb-2 rounded-xl bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600 space-y-3"
              }
            >
              {st.loading ? (
                <div className="thinking-bubble rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-3">
                  <div className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
                    <span className="thinking-text font-medium">正在全网搜集资料、生成详情</span>
                    <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                  </div>
                  {/* 骨架行：脉冲灰条，让"内容正在长出来"的过程可视化 */}
                  <div className="mt-2.5 space-y-1.5" aria-hidden="true">
                    <div className="h-2 w-11/12 rounded bg-indigo-100 animate-pulse" />
                    <div className="h-2 w-4/5 rounded bg-indigo-100 animate-pulse [animation-delay:150ms]" />
                    <div className="h-2 w-2/3 rounded bg-indigo-100 animate-pulse [animation-delay:300ms]" />
                  </div>
                </div>
              ) : st.error ? (
                <div>
                  <div className="text-gray-500 text-left">
                    {cleanMarkdown(st.data?.report || "详情获取失败，请稍后重试。")}
                  </div>
                  <div className="mt-2 flex flex-nowrap justify-end gap-2">
                    <button
                      onClick={() =>
                        loadDetail(key, topic, platform, url, suggestionItem ? entityName : "")
                      }
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-indigo-50 text-indigo-600 text-xs font-medium px-3 py-1 hover:bg-indigo-100 transition"
                    >
                      ↻ 刷新重试
                    </button>
                    {renderLlmActionButtons(st.data?.llmError)}
                  </div>
                </div>
              ) : st.data ? (
                <>
                  {/* 基本资料（主体条目才有）：这条切入所讲事件的基本盘——主体是谁上面
                      【主体速览】已讲过，这里不重复人物百科 */}
                  {st.data.profile && (
                    <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2.5 space-y-1">
                      <div className="font-semibold text-emerald-600">
                        📌 基本资料
                      </div>
                      <div className="whitespace-pre-wrap text-gray-700 leading-relaxed">
                        {cleanMarkdown(st.data.profile)}
                      </div>
                    </div>
                  )}
                  {st.data.material &&
                    (st.data.material.oneLine ||
                      (st.data.material.memes?.length ?? 0) > 0 ||
                      (st.data.material.angles?.length ?? 0) > 0 ||
                      (st.data.material.timeline?.length ?? 0) > 0 ||
                      (st.data.material.facts?.length ?? 0) > 0) && (
                      <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-2.5 space-y-2">
                        <div className="font-semibold text-indigo-600">
                          🎤 口播素材
                          {st.data.material.thin && (
                            <span className="ml-2 text-xs font-normal text-amber-500">
                              （资料较少，以下内容可能不完整，建议点开参考来源核实）
                            </span>
                          )}
                        </div>
                        {st.data.material.oneLine && (
                          <div className="text-gray-700 leading-relaxed">
                            {cleanMarkdown(st.data.material.oneLine)}
                          </div>
                        )}
                        {(st.data.material.timeline?.length ?? 0) > 0 && (
                          <div className="group/tlh">
                            {/* 标题：点击一次填入全部；鼠标悬停标题（组）时，下方有几条就几条
                                一起进入紫色加深态，让"这是一组、共几条"一眼可见 */}
                            <button
                              onClick={() => {
                                const tlItems = (
                                  st.data?.material?.timeline ?? []
                                ).map((x) => cleanMarkdown(x).trim());
                                // 按"条"判重：梗概里已有裸条或"N. 条"都算填过，
                                // 先点单条再点标题时只补缺的条，不整条重复灌
                                const stripNum = (s: string) =>
                                  s.replace(/^\d+[.、]\s*/, "");
                                const prevLines = scriptPlot
                                  .split(/\r?\n/)
                                  .map((s) => s.trim());
                                const missing = tlItems
                                  .map((it, i) =>
                                    prevLines.some(
                                      (l) => stripNum(l) === it
                                    )
                                      ? -1
                                      : i
                                  )
                                  .filter((i) => i >= 0);
                                if (missing.length === 0) return;
                                const fragment =
                                  (prevLines.includes("事件时间线：")
                                    ? ""
                                    : "事件时间线：\n") +
                                  missing
                                    .map((i) => `${i + 1}. ${tlItems[i]}`)
                                    .join("\n");
                                fillScriptField("plot", fragment, {
                                  topic,
                                  platform,
                                  report: st.data?.report || "",
                                  material: st.data?.material,
                                  entity: entityName,
                                  sites: st.data?.sites,
                                });
                              }}
                              title={`点击把全部 ${st.data.material.timeline!.length} 条填入「梗概」`}
                              className="mb-1 flex w-full items-center gap-1 text-left text-gray-700 group-hover/tlh:text-indigo-700 transition cursor-pointer"
                            >
                              <span>🕒 时间线</span>
                            </button>
                            {/* 竖向时间线：圆点用一根细竖线串起来，最后一个节点不拖尾线；
                                点单条只填该条进梗概，已填的圆点变绿打勾、柔和过渡 */}
                            <ul className="ml-1.5">
                              {st.data.material.timeline!.map((a, k, arr) => {
                                const itemText = cleanMarkdown(a);
                                const picked = scriptPlot.includes(itemText);
                                return (
                                <li key={k} className="relative pb-2.5 pl-4 last:pb-0">
                                  {k < arr.length - 1 && (
                                    <span
                                      aria-hidden
                                      className="absolute bottom-[2px] left-[3.5px] top-[7px] w-px bg-indigo-200"
                                    />
                                  )}
                                  <span
                                    aria-hidden
                                    className={`absolute left-0 top-[5px] h-[8px] w-[8px] rounded-full ring-[2.5px] transition-colors duration-200 ${
                                      picked
                                        ? "bg-emerald-500 ring-emerald-100"
                                        : "bg-indigo-400 ring-indigo-100"
                                    }`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      fillScriptField(
                                        "plot",
                                        a,
                                        {
                                          topic,
                                          platform,
                                          report: st.data?.report || "",
                                          material: st.data?.material,
                                          entity: entityName,
                                          sites: st.data?.sites,
                                        }
                                      )
                                    }
                                    title={
                                      picked
                                        ? "已填入「梗概」，再点不会重复"
                                        : "点击只把这一条填入「梗概」"
                                    }
                                    className={`block w-full rounded px-1 py-0.5 -ml-1 text-left leading-snug transition-colors duration-200 cursor-pointer ${
                                      picked
                                        ? "text-emerald-600 hover:bg-emerald-50 group-hover/tlh:bg-emerald-50"
                                        : "text-gray-700 hover:bg-indigo-100 hover:text-indigo-700 group-hover/tlh:bg-indigo-100 group-hover/tlh:text-indigo-700"
                                    }`}
                                  >
                                    {itemText}
                                    {picked && (
                                      <span className="ml-1.5 select-none text-[10px] text-emerald-500">
                                        ✓已填入
                                      </span>
                                    )}
                                  </button>
                                </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                        {(st.data.material.facts?.length ?? 0) > 0 && (
                          <div>
                            <div className="text-gray-500 mb-1">
                              可引用数据 / 事实
                              <span className="ml-1 text-[10px] text-gray-400">
                                （点击填入「希望植入的梗」）
                              </span>
                            </div>
                            <ul className="space-y-2">
                              {st.data.material.facts!.map((a, k) => (
                                <li key={k}>
                                  <button
                                    onClick={() =>
                                      fillScriptField("embed", a, {
                                        topic,
                                        platform,
                                        report: st.data?.report || "",
                                        material: st.data?.material,
                                        entity: entityName,
                                        sites: st.data?.sites,
                                      })
                                    }
                                    title="点击填入「希望植入的梗」"
                                    className="flex w-full items-start gap-1.5 text-left text-gray-700 rounded px-1 py-0.5 hover:bg-indigo-100 transition cursor-pointer"
                                  >
                                    <span className="text-indigo-400 leading-snug">
                                      •
                                    </span>
                                    <span className="leading-snug">
                                      {cleanMarkdown(a)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {(st.data.material.memes?.length ?? 0) > 0 && (
                          <div>
                            <div className="text-gray-500 mb-1">
                              热梗 / 金句
                              <span className="ml-1 text-[10px] text-gray-400">
                                （点击填入「希望植入的梗」）
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {st.data.material.memes!.map((m, k) => (
                                <button
                                  key={k}
                                  onClick={() =>
                                    fillScriptField("embed", m, {
                                      topic,
                                      platform,
                                      report: st.data?.report || "",
                                      material: st.data?.material,
                                      entity: entityName,
                                      sites: st.data?.sites,
                                    })
                                  }
                                  title="点击填入「希望植入的梗」"
                                  className="text-[11px] text-left px-2 py-0.5 rounded-[11px] bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-100 hover:border-indigo-300 transition cursor-pointer"
                                >
                                  {cleanMarkdown(m)}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {(st.data.material.angles?.length ?? 0) > 0 && (
                          <div>
                            <div className="text-gray-500 mb-1">
                              口播切入角度
                              <span className="ml-1 text-[10px] text-gray-400">
                                （点击填入「梗概」）
                              </span>
                            </div>
                            <ul className="space-y-2">
                              {st.data.material.angles!.map((a, k) => (
                                <li key={k}>
                                  <button
                                    onClick={() =>
                                      fillScriptField("plot", a, {
                                        topic,
                                        platform,
                                        report: st.data?.report || "",
                                        material: st.data?.material,
                                        entity: entityName,
                                        sites: st.data?.sites,
                                      })
                                    }
                                    title="点击填入「梗概」"
                                    className="flex w-full items-start gap-1.5 text-left text-gray-700 rounded px-1 py-0.5 hover:bg-indigo-100 transition cursor-pointer"
                                  >
                                    <span className="text-indigo-400 leading-snug">
                                      •
                                    </span>
                                    <span className="leading-snug">
                                      {cleanMarkdown(a)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  <div>
                    <div className="font-semibold text-gray-700 mb-1">
                      📄 详细报道
                    </div>
                    <div className="whitespace-pre-wrap leading-relaxed">
                      {cleanMarkdown(st.data.report)}
                    </div>
                  </div>
                  {st.data.sites?.length > 0 && (
                    <RefSitesBlock
                      sites={st.data.sites}
                      onOpenApp={(u) => openPlatformUrl(u)}
                    />
                  )}
                  {st.data.videos?.length > 0 && (
                    <RefVideosBlock
                      videos={st.data.videos}
                      onOpenApp={(u, app) => openPlatformUrl(u, app)}
                    />
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      );
    });
    // 参考来源条：置顶、默认折叠（无参考来源时不占位）。淡灰小卡与正文区分，点开才展开链接。
    // 「今日暂无」灰条在参考块【更上方】：整条全宽、与参考块同宽、文字左对齐。
    return (
      <>
        {noticeBars.length > 0 &&
          noticeBars.map((n, i) => (
            <div
              key={`notice-${i}`}
              className="mb-2.5 w-full rounded-lg bg-gray-100 px-3 py-2 text-left text-xs leading-relaxed text-gray-500"
            >
              {n}
            </div>
          ))}
        {topRefs.length > 0 && (
          <div
            key="top-refs"
            className="mb-2.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5"
          >
            <div className="space-y-1.5">
              {topRefs.map((b, i) => (
                <Fragment key={i}>
                  {b.sites.length > 0 && (
                    <RefSitesBlock
                      sites={b.sites}
                      onOpenApp={(u) => openPlatformUrl(u)}
                    />
                  )}
                  {b.videos.length > 0 && (
                    <RefVideosBlock
                      videos={b.videos}
                      onOpenApp={(u, app) => openPlatformUrl(u, app)}
                    />
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        )}
        {bodyNodes}
      </>
    );
  };

  // 打开平台链接的统一入口（参考网站/参考视频共用）：
  // 桌面端一律开新标签；移动端走「App scheme 唤起 → 失败弹操作表」链路（见 APP_FALLBACKS）。
  // 显式传入的 app scheme 优先于按 URL 识别出的 scheme。
  // 2026-09 三次加固：
  // ① 微信/QQ 内置浏览器（MicroMessenger/QQWebView）会静默屏蔽所有自定义 scheme，
  //    JS 跳转完全无效——这是"点了没反应/打不开 App"最常见的真因，直接弹引导层
  //    让用户去系统浏览器打开（系统浏览器里 scheme 才生效）；
  // ② scheme 没唤起时不再自动甩到荒芜网页，而是弹【操作表】：真正的 <a href=scheme>
  //    由用户手势点击（比 location.href 更能过浏览器拦截）、备选协议、下载 App、
  //    继续看网页版四个动作，用户自己选；
  // ③ iOS/Android 下载页分开（App Store / 应用宝），协议按系统给（安卓 xhsdiscovery）。
  const openPlatformUrl = (url: string, appScheme?: string) => {
    const ua = navigator.userAgent;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
    if (!isMobile) {
      window.open(url, "_blank", "noopener");
      return;
    }
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const inWechatLike = /MicroMessenger|QQ\/[\d.]+|QHBrowser/i.test(ua);
    const hit = resolveAppFallback(url);
    const schemes = appScheme
      ? [appScheme]
      : hit
        ? hit.fb.schemes(hit.key, isIOS)
        : [];
    if (!schemes.length || !hit) {
      // 识别不出平台的普通链接：保持原行为开新标签
      window.open(url, "_blank", "noopener");
      return;
    }
    const { fb } = hit;
    const webUrl = fb.web ? fb.web(url) : url;
    const dl = isIOS ? fb.dlIOS : fb.dlAd;
    // 微信/QQ 内：scheme 必被拦截，直接给"去浏览器打开"引导（附操作表备用）
    if (inWechatLike) {
      setAppJumpSheet({
        appName: fb.appName,
        schemes,
        webUrl,
        dl,
        blocked: true,
      });
      return;
    }
    // 普通移动浏览器：立刻试主 scheme（同步执行，算用户手势）。1.4s 后页面仍可见
    // = 没唤起（没装 App/协议不认/被拦）→ 弹操作表，不再自动跳荒芜网页。
    const timer = setTimeout(() => {
      if (!document.hidden) {
        setAppJumpSheet({ appName: fb.appName, schemes, webUrl, dl, blocked: false });
      }
    }, 1400);
    document.addEventListener("visibilitychange", () => clearTimeout(timer), {
      once: true,
    });
    window.location.href = schemes[0];
  };

  return (
    <main className="h-[100dvh] flex flex-col bg-[linear-gradient(180deg,#e9ecff_0%,#f5f6ff_40%,#ffffff_72%)] overflow-hidden">
      {/* 移动端 App 唤起操作表：微信/QQ 内引导去系统浏览器；普通浏览器 scheme 失败后给
          「再试唤起（真实 <a> 用户手势）/备选协议/下载 App/看网页版」 */}
      {appJumpSheet && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setAppJumpSheet(null)}
          />
          <div className="relative z-10 w-full sm:max-w-xs bg-white rounded-t-2xl sm:rounded-2xl shadow-softer p-5 space-y-3">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">
                {appJumpSheet.blocked
                  ? `在${appJumpSheet.appName}App 中打开`
                  : `没有自动打开${appJumpSheet.appName}？`}
              </div>
              {appJumpSheet.blocked ? (
                <p className="text-sm text-gray-500 leading-relaxed">
                  当前是微信/QQ 内置浏览器，它会屏蔽跳转到其他 App。请点右上角
                  <span className="text-gray-700 font-semibold">「···」</span>
                  菜单，选择
                  <span className="text-gray-700 font-semibold">「在浏览器打开」</span>
                  ，回到本页后再点一次链接即可唤起{appJumpSheet.appName}
                  App。也可以直接用下面的按钮：
                </p>
              ) : (
                <p className="text-sm text-gray-500 leading-relaxed">
                  可能是没安装{appJumpSheet.appName}
                  App，或浏览器拦截了自动跳转。点下面的按钮手动打开；仍打不开可下载 App
                  或先看网页版。
                </p>
              )}
            </div>
            {/* 真实 <a href=scheme>：用户手势点击是唤起 App 最可靠的方式 */}
            {appJumpSheet.schemes.slice(0, appJumpSheet.blocked ? 1 : 2).map((s, i) => (
              <a
                key={s}
                href={s}
                className={`block text-center text-sm font-semibold px-3 py-2.5 rounded-xl transition ${
                  i === 0
                    ? "bg-indigo-500 text-white hover:bg-indigo-600"
                    : "border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
                }`}
              >
                {i === 0
                  ? `📱 在${appJumpSheet.appName}App中打开`
                  : "换一种方式唤起"}
              </a>
            ))}
            {appJumpSheet.dl && (
              <a
                href={appJumpSheet.dl}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-sm px-3 py-2.5 rounded-xl border text-gray-700 hover:bg-gray-50 transition"
              >
                ⬇️ 下载 / 安装{appJumpSheet.appName}App
              </a>
            )}
            <button
              onClick={() => {
                setAppJumpSheet(null);
                window.open(appJumpSheet.webUrl, "_blank", "noopener");
              }}
              className="w-full text-center text-sm px-3 py-2.5 rounded-xl text-gray-500 hover:bg-gray-50 transition"
            >
              🌐 先看网页版（可能要求登录）
            </button>
            <button
              onClick={() => setAppJumpSheet(null)}
              className="w-full text-center text-xs px-3 py-1.5 text-gray-400"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {/* 删除会话二次确认 */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setPendingDelete(null)}
          />
          <div className="relative z-10 w-full max-w-xs bg-white rounded-2xl shadow-softer p-5 space-y-4">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">删除会话</div>
              <p className="text-sm text-gray-500 leading-relaxed">
                确定删除会话「
                <span className="text-gray-700">{pendingDelete.title}</span>
                」吗？该会话的聊天记录将被清除，此操作不可撤销。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
              >
                取消
              </button>
              <button
                onClick={() => deleteSession(pendingDelete.id)}
                className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加 / 编辑自定义领域 */}
      {replaceCandidate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setReplaceCandidate(null)}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-softer p-5 space-y-4">
            <div className="font-bold text-gray-800">最多选 {MAX_DOMAINS} 个领域</div>
            <p className="text-sm text-gray-500">
              已选满 {MAX_DOMAINS} 个。要把
              <span className="mx-1 font-medium text-emerald-600">{replaceCandidate}</span>
              替换掉下面哪一个？
            </p>
            <div className="flex flex-col gap-2">
              {selectedDomains.map((d) => (
                <button
                  key={d}
                  onClick={() => confirmReplaceDomain(d)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-emerald-400 hover:bg-emerald-50 transition text-left"
                >
                  替换「{d}」
                </button>
              ))}
            </div>
            <button
              onClick={() => setReplaceCandidate(null)}
              className="w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-600 transition"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 平台选择弹窗：上块=已选（点击移除），下块=未选（点击添加），最多 MAX_PLATFORMS 个 */}
      {platformPickerOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setPlatformPickerOpen(false)}
          />
          <div className="relative z-10 w-full max-w-lg bg-white rounded-2xl shadow-softer flex flex-col max-h-[88vh]">
            {/* 头部固定：标题 + 清空/重置 */}
            <div className="shrink-0 px-4 pt-4 pb-3 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <div className="font-bold text-gray-800">
                  选择抓取平台
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    已选 {draftPlatforms.length}/{MAX_PLATFORMS}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={clearDraftPlatforms}
                    className="text-xs text-gray-500 hover:text-red-500 transition"
                  >
                    清空
                  </button>
                  <span className="h-3 w-px bg-gray-200" />
                  <button
                    onClick={resetDraftPlatforms}
                    className="text-xs text-gray-500 hover:text-indigo-600 transition"
                  >
                    重置
                  </button>
                </div>
              </div>
            </div>

            {/* 中部滚动：两块平台列表 */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">
                  已选平台
                  <span className="text-gray-300">（点击移到下面）</span>
                </div>
                {draftPlatforms.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {PLATFORMS.filter((p) => draftPlatforms.includes(p)).map(
                      (p) => renderPickerChip(p, true)
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400 py-2">
                    暂无已选平台，点击下面的平台添加
                  </div>
                )}
              </div>
              <div className="border-t border-gray-100 pt-3">
                <div className="text-xs font-medium text-gray-500 mb-2">
                  未选平台
                  <span className="text-gray-300">（点击移到上面）</span>
                  {draftPlatforms.length >= MAX_PLATFORMS && (
                    <span className="ml-1 text-red-400">
                      已达上限 {MAX_PLATFORMS} 个
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.filter((p) => !draftPlatforms.includes(p)).map(
                    (p) => renderPickerChip(p, false)
                  )}
                </div>
              </div>
            </div>

            {/* 底部固定：取消 / 确定 */}
            <div className="shrink-0 px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                onClick={() => setPlatformPickerOpen(false)}
                className="px-4 py-1.5 rounded-lg text-sm text-gray-500 border border-gray-200 hover:bg-gray-50 transition"
              >
                取消
              </button>
              <button
                onClick={confirmDraftPlatforms}
                disabled={draftPlatforms.length === 0}
                className={`px-4 py-1.5 rounded-lg text-sm text-white transition ${
                  draftPlatforms.length === 0
                    ? "bg-gray-300 cursor-not-allowed"
                    : "bg-gradient-to-br from-indigo-500 to-violet-500 hover:opacity-90 shadow-md shadow-indigo-200/60"
                }`}
                title={
                  draftPlatforms.length === 0 ? "至少选择 1 个平台" : undefined
                }
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 生成脚本弹窗 */}
      {scriptModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => !scriptGenerating && setScriptModal(null)}
          />
          <div className="relative z-10 w-full max-w-lg bg-white rounded-2xl shadow-softer flex flex-col max-h-[88vh]">
            {/* 头部固定：标题 + 热点事件行（不随内容滚动） */}
            <div className="shrink-0 px-4 pt-4 pb-3 border-b border-gray-100">
              <div className="flex items-baseline gap-2">
                <div className="font-bold text-gray-800 shrink-0">生成脚本</div>
                <p className="text-xs text-gray-400 truncate">
                  热点事件：{scriptModal.topic}
                </p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* 脚本类型：三选一 */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">脚本类型</label>
              <div className="flex gap-2">
                {(["口播稿", "情景演绎", "AI生视频"] as ScriptType[]).map((t) => {
                  const disabled = t !== "口播稿";
                  if (disabled) {
                    return (
                      <div key={t} className="relative group cursor-not-allowed">
                        <button
                          disabled
                          className="px-4 py-1 rounded-lg border border-gray-200 bg-gray-100 text-gray-300 text-sm cursor-not-allowed pointer-events-none"
                        >
                          {t}
                        </button>
                        {/* 自绘 tooltip：hover 即时显示，无系统延迟 */}
                        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 whitespace-nowrap rounded-md bg-gray-800 text-white text-[11px] px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-soft">
                          功能尚在开发中，敬请期待
                          <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
                        </div>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={t}
                      onClick={() => setScriptType(t)}
                      className={`px-4 py-1 rounded-lg border text-sm transition ${
                        scriptType === t
                          ? "border-indigo-400 bg-indigo-50 text-indigo-600 font-medium"
                          : "border-gray-200 text-gray-600 hover:border-indigo-300"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 脚本时长：离散滑块（30秒步长，30秒~5分钟），实时展示时长+参考字数 */}
            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <label className="text-sm font-medium text-gray-700">脚本时长</label>
                <span className="text-sm font-medium text-indigo-600">
                  {DURATION_STEPS[durationIdx].label}
                  <span className="ml-1 text-xs text-gray-400">
                    （参考字数 {DURATION_STEPS[durationIdx].words}）
                  </span>
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={DURATION_STEPS.length - 1}
                step={1}
                value={durationIdx}
                onChange={(e) => setDurationIdx(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-gray-300 -mt-1.5">
                <span>30秒</span>
                <span>5分钟</span>
              </div>
            </div>
            {/* SCRIPT_MODAL_REST */}

            {/* 梗概（选填）+ 润色梗概 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">
                  梗概（选填）
                </label>
                <button
                  onClick={polishPlot}
                  disabled={!scriptPlot.trim() || polishing}
                  className={`px-3 py-1 rounded-lg border text-xs transition ${
                    !scriptPlot.trim() || polishing
                      ? "border-gray-200 text-gray-300 cursor-not-allowed"
                      : "border-indigo-300 text-indigo-600 hover:bg-indigo-50"
                  }`}
                >
                  {polishing ? "润色中…" : "润色梗概"}
                </button>
              </div>
              <textarea
                value={scriptPlot}
                onChange={(e) => setScriptPlot(e.target.value)}
                rows={4}
                placeholder="用一两句话写下想怎么讲（100字左右即可），点击润色梗概可结合热点与爆款套路帮你理顺。完整口播稿由下方一键生成脚本产出。"
                className={`w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 focus:border-indigo-400 focus:outline-none resize-y ${
                  plotFlash > 0 ? "plot-flash" : ""
                }`}
              />
              {(scriptModal.material?.angles?.length ?? 0) > 0 && (
                <div className="pt-0.5">
                  <div className="flex flex-col gap-1.5">
                    {scriptModal.material!.angles!.map((a, k) => {
                      const clean = cleanMarkdown(a);
                      return (
                        <button
                          key={k}
                          onClick={() =>
                            fillScriptField("plot", a, {
                              topic: scriptModal.topic,
                              platform: scriptModal.platform,
                              report: scriptModal.report,
                              material: scriptModal.material,
                              sites: scriptModal.sites,
                            })
                          }
                          className="flex items-start gap-1.5 text-left text-xs rounded px-2 py-1 border border-gray-200 text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 transition"
                        >
                          <span className="leading-none">+</span>
                          <span className="leading-snug">{clean}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 希望植入的梗、台词或桥段 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">
                希望植入的梗、台词或桥段
              </label>
              <textarea
                value={scriptEmbed}
                onChange={(e) => setScriptEmbed(e.target.value)}
                rows={3}
                placeholder="输入想要植入的梗、彩蛋、特定台词、名场面，AI会尽量将其融入生成的脚本中。"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 focus:border-indigo-400 focus:outline-none resize-y"
              />
              {(scriptModal.material?.memes?.length ?? 0) > 0 && (
                <div className="pt-0.5">
                  <div className="flex flex-wrap gap-1.5">
                    {scriptModal.material!.memes!.map((m, k) => {
                      const clean = cleanMarkdown(m);
                      const picked = scriptEmbed.includes(clean);
                      return (
                        <button
                          key={k}
                          onClick={() =>
                            fillScriptField("embed", m, {
                              topic: scriptModal.topic,
                              platform: scriptModal.platform,
                              report: scriptModal.report,
                              material: scriptModal.material,
                              sites: scriptModal.sites,
                            })
                          }
                          className={`text-[11px] text-left px-2 py-0.5 rounded-[11px] border transition ${
                            picked
                              ? "border-indigo-300 bg-indigo-50 text-indigo-500"
                              : "border-gray-200 text-gray-600 hover:border-indigo-300 hover:bg-indigo-50"
                          }`}
                        >
                          {picked ? "✓ " : "+ "}
                          {clean}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 一稿多发：同一选题多平台成稿 */}
            <div className="space-y-2 pt-1 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">
                  一稿多发
                  <span className="ml-1 text-[10px] text-gray-400">
                    （同一选题，两个平台直接成稿）
                  </span>
                </label>
                <button
                  onClick={generateMulti}
                  disabled={multiLoading}
                  className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg border text-xs transition ${
                    multiLoading
                      ? "border-gray-200 text-gray-400 cursor-not-allowed"
                      : "border-indigo-300 text-indigo-600 hover:bg-indigo-50"
                  }`}
                >
                  {multiLoading && (
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
                  )}
                  {multiLoading
                    ? "生成中…"
                    : multiPack
                    ? "重新生成"
                    : "生成多平台成稿"}
                </button>
              </div>
              {(["xhs", "gzh"] as const).map((pf) => {
                const it = multiPack?.[pf];
                if (!it) return null;
                const name = pf === "xhs" ? "小红书图文" : "公众号短文";
                const fullText = [
                  ...it.titles.map((t) => `标题：${t}`),
                  it.cover ? `封面：${it.cover}` : "",
                  it.body,
                  it.tags.join(" "),
                ]
                  .filter(Boolean)
                  .join("\n\n");
                return (
                  <div
                    key={pf}
                    className="rounded-lg border border-gray-200 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-700">
                        {name}
                      </span>
                      <button
                        onClick={() => {
                          try {
                            navigator.clipboard.writeText(fullText);
                          } catch (e) {
                            console.debug("[ui] 剪贴板不可用，复制全文失败:", e);
                          }
                        }}
                        className="text-[11px] text-indigo-600 hover:underline"
                      >
                        复制全文
                      </button>
                    </div>
                    {it.titles.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {it.titles.map((t, k) => (
                          <button
                            key={k}
                            onClick={() => {
                              try {
                                navigator.clipboard.writeText(t);
                              } catch (e) {
                                console.debug("[ui] 剪贴板不可用，复制标题失败:", e);
                              }
                            }}
                            title="点击复制标题"
                            className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-100 transition"
                          >
                            {cleanMarkdown(t)}
                          </button>
                        ))}
                      </div>
                    )}
                    {it.cover && (
                      <div className="text-xs text-gray-500">
                        封面文案：{cleanMarkdown(it.cover)}
                      </div>
                    )}
                    {it.body && (
                      <div className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                        {cleanMarkdown(it.body)}
                      </div>
                    )}
                    {it.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {it.tags.map((t, k) => (
                          <span
                            key={k}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-500"
                          >
                            {cleanMarkdown(t)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            </div>

            {/* 底部操作：取消 / 一键生成脚本（固定在弹窗底部，内容区独立滚动） */}
            <div className="shrink-0 border-t border-gray-100 p-4">
              <div className="flex gap-2">
              <button
                onClick={() => !scriptGenerating && setScriptModal(null)}
                disabled={scriptGenerating}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={generateScript}
                disabled={scriptGenerating}
                className="inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition disabled:opacity-60"
              >
                {scriptGenerating && (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
                )}
                {scriptGenerating ? "生成中…" : "一键生成脚本"}
              </button>
              </div>
            </div>
          </div>
        </div>
      )}



      {schedReplaceCandidate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSchedReplaceCandidate(null)}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-softer p-5 space-y-4">
            <div className="font-bold text-gray-800">最多选 {MAX_DOMAINS} 个领域</div>
            <p className="text-sm text-gray-500">
              已选满 {MAX_DOMAINS} 个。要把
              <span className="mx-1 font-medium text-emerald-600">{schedReplaceCandidate}</span>
              替换掉下面哪一个？
            </p>
            <div className="flex flex-col gap-2">
              {schedDomains.map((d) => (
                <button
                  key={d}
                  onClick={() => confirmSchedReplaceDomain(d)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-emerald-400 hover:bg-emerald-50 transition text-left"
                >
                  替换「{d}」
                </button>
              ))}
            </div>
            <button
              onClick={() => setSchedReplaceCandidate(null)}
              className="w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-600 transition"
            >
              取消
            </button>
          </div>
        </div>
      )}


      {showDomainInput && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeDomainInput}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-softer flex flex-col max-h-[85vh]">
            {/* 头部固定 */}
            <div className="shrink-0 px-5 pt-5 pb-3 border-b border-gray-100">
              <div className="font-bold text-gray-800">
                {editingDomain ? "编辑领域" : "添加领域"}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">领域名称</label>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={domainInput}
                    onChange={(e) => {
                      setDomainInput(e.target.value);
                      // 名称变化后需要重新确认
                      if (e.target.value.trim() !== meaningForName) {
                        setMeaningConfirmed(false);
                        setMeaningOptions([]);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmDomainMeaning();
                      if (e.key === "Escape") closeDomainInput();
                    }}
                    placeholder="例如：反bl"
                    className="flex-1 px-3 py-2 rounded-lg text-sm border border-gray-300 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <button
                    onClick={confirmDomainMeaning}
                    disabled={!domainInput.trim() || meaningLoading}
                    className="shrink-0 text-sm px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {meaningLoading ? "识别中…" : "识别含义"}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400">
                  若词语本身含义清晰、无歧义，无需识别含义。
                </p>
              </div>

              {/* 第二步：模型给出的候选释义 */}
              {meaningConfirmed && (
                <div className="space-y-1.5">
                  <label className="text-xs text-gray-400">可选释义</label>
                  {meaningLoading ? (
                    <div className="text-xs text-gray-400 py-1">正在识别「{domainInput.trim()}」的含义…</div>
                  ) : meaningOptions.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {meaningOptions.map((opt, i) => {
                        const active = noteInput.trim() === opt;
                        return (
                          <button
                            key={i}
                            onClick={() => setNoteInput(opt)}
                            className={
                              "text-left text-xs px-3 py-2 rounded-lg border transition " +
                              (active
                                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                                : "border-gray-200 text-gray-600 hover:border-emerald-300 hover:bg-emerald-50/40")
                            }
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 py-1">没有识别到合适的释义，可在下方自行填写。</div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs text-gray-400">
                  释义（选填）
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={3}
                  placeholder="可说明词语含义，避免被泛化。若词语本身清晰、无歧义则无需填写。"
                  className="w-full px-3 py-2 rounded-lg text-sm border border-gray-300 focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                />
              </div>
            </div>
            </div>
            {/* 底部固定：删除 / 取消 / 保存（不随内容滚动） */}
            <div className="shrink-0 flex justify-between items-center border-t border-gray-100 px-5 py-3">
              {editingDomain ? (
                <button
                  onClick={() => setPendingDeleteDomain(editingDomain)}
                  className="text-sm px-3 py-1.5 rounded-lg border border-red-300 text-red-500 hover:bg-red-50 transition"
                >
                  删除
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={closeDomainInput}
                  className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
                >
                  取消
                </button>
                <button
                  onClick={saveDomain}
                  className="text-sm px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除自定义领域二次确认 */}
      {pendingDeleteDomain && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setPendingDeleteDomain(null)}
          />
          <div className="relative z-10 w-full max-w-xs bg-white rounded-2xl shadow-softer p-5 space-y-4">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">删除自定义领域</div>
              <p className="text-sm text-gray-500 leading-relaxed">
                确定删除「
                <span className="text-gray-700">{pendingDeleteDomain}</span>
                」吗？
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDeleteDomain(null)}
                className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
              >
                取消
              </button>
              <button
                onClick={() => deleteDomain(pendingDeleteDomain)}
                className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 跨设备同步 */}
      {showSync && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowSync(false)}
          />
          <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-softer flex flex-col max-h-[85vh]">
            {/* 头部固定 */}
            <div className="shrink-0 flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
              <span className="font-bold text-gray-800">跨设备同步</span>
              <button
                onClick={() => setShowSync(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <p className="text-xs text-gray-500 leading-relaxed">
              用一串「同步码」在多台设备间共享会话与设置，无需注册登录。在新设备打开本站，输入同一串码即可拉取数据。
            </p>

            {syncCode ? (
              <div className="space-y-3">
                <div className="text-xs text-gray-400">你的同步码</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-gray-50 border rounded-lg px-3 py-2 text-sm font-mono tracking-wide select-all">
                    {syncCode}
                  </code>
                  <button
                    onClick={copyCode}
                    className="text-xs shrink-0 px-3 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <p className="text-xs text-gray-400">
                  在其他设备打开本站 → 点「🔄 同步」→ 输入此码即可。
                  {lastSyncAt > 0 && (
                    <>
                      <br />
                      上次同步：{new Date(lastSyncAt).toLocaleString()}
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => pushSync(syncCode)}
                    disabled={syncBusy}
                    className="text-sm px-3 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                  >
                    立即上传
                  </button>
                  <button
                    onClick={() => pullSync(syncCode)}
                    disabled={syncBusy}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
                  >
                    {syncBusy ? "处理中…" : "从云端拉取"}
                  </button>
                  <button
                    onClick={disableSync}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-400 hover:text-red-500 hover:border-red-300 transition ml-auto"
                  >
                    停用同步
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={enableSync}
                  disabled={syncBusy}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                >
                  {syncBusy ? "处理中…" : "启用同步（生成我的同步码）"}
                </button>
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <div className="flex-1 h-px bg-gray-200" />
                  或输入已有同步码
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !syncBusy && importCode()}
                    placeholder="hot-xxxx-xxxx-xxxx"
                    className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <button
                    onClick={importCode}
                    disabled={syncBusy || !codeInput.trim()}
                    className="text-sm shrink-0 px-3 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
                  >
                    {syncBusy ? "…" : "导入"}
                  </button>
                </div>
              </div>
            )}

            {syncMsg && (
              <div
                className={`text-xs ${
                  syncMsg.ok ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {syncMsg.text}
              </div>
            )}

            <p className="text-[11px] text-gray-400 leading-relaxed border-t pt-3">
              ⚠️ 持有同步码的人都能读写你的数据，请勿公开分享。多台设备同时编辑时，以最后一次上传为准。
            </p>
            </div>
          </div>
        </div>
      )}

      {/* 🤖 AI 模型设置弹窗（BYOK：下拉选平台 + 自带 Key） */}
      {showLlm && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowLlm(false)}
          />
          <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-softer flex flex-col max-h-[85vh]">
            <div className="shrink-0 flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
              <span className="font-bold text-gray-800">🤖 AI 模型设置</span>
              <button
                onClick={() => setShowLlm(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <p className="text-xs text-gray-500 leading-relaxed">
                选择你要用的 AI 平台并填写自己的 API Key，Key 只保存在你本机浏览器里、随请求使用，
                不会被服务器存储。不填则使用站点默认模型（DeepSeek），开箱即用。
              </p>

              <div className="space-y-1.5">
                <label className="text-xs text-gray-500">平台</label>
                <select
                  value={llmProvider}
                  onChange={(e) => onLlmProviderChange(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                >
                  {LLM_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {getProviderPreset(llmProvider).keyUrl && (
                  <p className="text-[11px] text-gray-400">
                    没有 Key？去
                    <a
                      href={getProviderPreset(llmProvider).keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-500 hover:underline mx-0.5"
                    >
                      {getProviderPreset(llmProvider).name.replace("（默认）", "")} 开放平台
                    </a>
                    申请（各家平台均免费送额度）。
                  </p>
                )}
                {getProviderPreset(llmProvider).topupUrl && (
                  <p className="text-[11px] text-gray-400">
                    额度用完？
                    <a
                      href={getProviderPreset(llmProvider).topupUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-600 hover:underline mx-0.5"
                    >
                      直达{getProviderPreset(llmProvider).name.replace("（默认）", "")}充值页
                    </a>
                    充值到账后即可继续使用。
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-gray-500">
                  API Key
                  {llmSaved?.apiKey && (
                    <span className="ml-2 text-emerald-600">
                      已配置（{getProviderPreset(llmSaved.provider).name}）
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={llmKeyInput}
                  onChange={(e) => setLlmKeyInput(e.target.value)}
                  placeholder={
                    llmSaved?.apiKey
                      ? "已保存，留空则不修改；输入新值可替换"
                      : "sk-...（不填则使用站点默认 DeepSeek）"
                  }
                  autoComplete="off"
                  className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-gray-500">接口地址（Base URL）</label>
                <input
                  type="text"
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-gray-500">模型名</label>
                <input
                  type="text"
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder={
                    getProviderPreset(llmProvider).modelPlaceholder ||
                    getProviderPreset(llmProvider).model ||
                    "模型名"
                  }
                  className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                {llmProvider === "doubao" && (
                  <p className="text-[11px] text-amber-600">
                    豆包要填「在线推理接入点 ID」（形如 ep-2025xxxxxx-xxxxx），不是模型显示名，在火山方舟控制台「在线推理」页创建。
                  </p>
                )}
              </div>

              {llmTestMsg && (
                <div className="space-y-2">
                  <div
                    className={`text-xs leading-relaxed ${
                      llmTestMsg.ok ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {llmTestMsg.text}
                  </div>
                  {/* 测试出 Key 无效/欠费：直接给直达按钮——充值页/Key 管理页，不用自己去菜单里找 */}
                  {!llmTestMsg.ok && llmTestMsg.action && (
                    <div className="flex flex-wrap gap-2">
                      {llmTestMsg.action.kind === "no_balance" &&
                        llmTestMsg.action.topupUrl && (
                          <a
                            href={llmTestMsg.action.topupUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center rounded-full bg-emerald-500 text-white text-xs font-medium px-3 py-1 hover:bg-emerald-600 transition"
                          >
                            💰 去{llmTestMsg.action.providerName}充值（直达充值页）
                          </a>
                        )}
                      {llmTestMsg.action.keyUrl && (
                        <a
                          href={llmTestMsg.action.keyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center rounded-full bg-indigo-50 text-indigo-600 text-xs font-medium px-3 py-1 hover:bg-indigo-100 transition"
                        >
                          🔑 {llmTestMsg.action.kind === "no_balance" ? "更换 / 申请 Key" : "去申请 / 管理 Key"}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={llmTest}
                  disabled={llmBusy}
                  className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
                >
                  {llmBusy ? "测试中…" : "测试连接"}
                </button>
                <button
                  onClick={llmSave}
                  disabled={llmBusy}
                  className="text-sm px-3 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                >
                  保存
                </button>
                {llmSaved?.apiKey && (
                  <button
                    onClick={llmClear}
                    disabled={llmBusy}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-400 hover:text-red-500 hover:border-red-300 transition ml-auto"
                  >
                    清除我的 Key
                  </button>
                )}
              </div>

              <p className="text-[11px] text-gray-400 leading-relaxed border-t pt-3">
                所有平台都走 OpenAI 兼容接口；自定义平台填对 Base URL 和模型名即可接入。
                Key 仅存于本机 localStorage，换设备/清缓存后需重新填写。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 定时任务配置弹窗 */}
      {showSchedule && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowSchedule(false)}
          />
          <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-softer flex flex-col max-h-[88vh]">
            {/* 头部固定：标题 + 启用开关 + 关闭 */}
            <div className="shrink-0 flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
              <div className="flex items-center gap-4">
                <span className="font-bold text-gray-800">⏰ 定时任务</span>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 font-normal">
                  <input
                    type="checkbox"
                    checked={schedEnabled}
                    disabled={!schedEditMode}
                    onChange={(e) => setSchedEnabled(e.target.checked)}
                    className="w-4 h-4 disabled:opacity-90"
                  />
                  启用
                </label>
              </div>
              <button
                onClick={() => setShowSchedule(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>
            {/* 内容区独立滚动 */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {(
              <div className="space-y-4">
                <div
                  className={`space-y-4 transition ${
                    !schedEnabled
                      ? "opacity-40 pointer-events-none grayscale"
                      : !schedEditMode
                      ? "pointer-events-none [&_input]:opacity-50 [&_select]:opacity-50 [&_button]:opacity-50"
                      : ""
                  }`}
                >
                  <div className="space-y-2 text-sm text-gray-700">
                  <div className="flex items-center gap-2">
                    <span>开始日期</span>
                    <button
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setStartDatePop({ top: Math.min(r.bottom + 6, window.innerHeight - 200), left: Math.max(8, Math.min(r.left, window.innerWidth - 250)) });
                      }}
                      className={`${FIELD_CLS} w-28 shrink-0`}
                    >
                      {schedStartDate || "选择日期"}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span>结束日期</span>
                    <button
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setEndDatePop({ top: Math.min(r.bottom + 6, window.innerHeight - 200), left: Math.max(8, Math.min(r.left, window.innerWidth - 250)) });
                      }}
                      className={`${FIELD_CLS} w-28 shrink-0 ${schedEndDate ? "" : "text-gray-400"}`}
                    >
                      {schedEndDate || "永久运行"}
                    </button>
                    {schedEndDate && (
                      <button
                        onClick={() => setSchedEndDate("")}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-gray-700">
                  <span>频率：每</span>
                  <select
                    value={schedEveryDays}
                    onChange={(e) => setSchedEveryDays(Number(e.target.value))}
                    className={SELECT_CLS}
                  >
                    {[1, 2, 3, 5, 7, 14, 30].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span>天</span>
                </div>

                <div className="space-y-2">
                  <div className="text-sm text-gray-700">
                    触发时间
                  </div>
                  {schedTimes.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setTimePopIdx({ idx: i, top: Math.min(r.bottom + 6, window.innerHeight - 200), left: Math.max(8, Math.min(r.left, window.innerWidth - 160)) });
                        }}
                        className={`${FIELD_CLS} w-20 shrink-0`}
                      >
                        {t}
                      </button>
                      {schedTimes.length > 1 && (
                        <button
                          onClick={() =>
                            setSchedTimes(schedTimes.filter((_, j) => j !== i))
                          }
                          className="text-gray-400 hover:text-red-500 text-sm px-2"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                  {schedTimes.length < 3 && (
                    <button
                      onClick={() =>
                        setSchedTimes([
                          ...schedTimes,
                          schedTimes.length >= 2 ? "16:00" : "12:00",
                        ])
                      }
                      className="text-xs text-indigo-500 hover:text-indigo-600"
                    >
                      + 添加时间
                    </button>
                  )}
                </div>

                {/* 日期/时间滚轮弹层 */}
                {startDatePop && (
                  <DateWheelBody
                    value={schedStartDate || todayStr()}
                    pos={startDatePop}
                    onConfirm={(v) => {
                      setSchedStartDate(v);
                      setStartDatePop(null);
                    }}
                    onClose={() => setStartDatePop(null)}
                  />
                )}
                {endDatePop && (
                  <DateWheelBody
                    value={schedEndDate || todayStr()}
                    minDate={schedStartDate || undefined}
                    pos={endDatePop}
                    onConfirm={(v) => {
                      setSchedEndDate(v);
                      setEndDatePop(null);
                    }}
                    onClose={() => setEndDatePop(null)}
                  />
                )}
                {timePopIdx && (
                  <TimeWheelBody
                    value={schedTimes[timePopIdx.idx] || "09:00"}
                    pos={timePopIdx}
                    onConfirm={(v) => {
                      const next = [...schedTimes];
                      next[timePopIdx.idx] = v;
                      setSchedTimes(next);
                      setTimePopIdx(null);
                    }}
                    onClose={() => setTimePopIdx(null)}
                  />
                )}

                {/* 关注领域：逻辑与主页面一致（不选=全部热点，最多 3 个） */}
                <div className="space-y-1.5">
                  <div className="text-sm text-gray-700">
                    关注领域
                    <span className="text-gray-300">
                      （不选 = 抓取全部热点，最多选 {MAX_DOMAINS} 个）
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {domainOptions.map((d) => {
                      const on = schedDomains.includes(d);
                      return (
                        <button
                          key={d}
                          onClick={() => toggleSchedDomain(d)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition ${
                            on
                              ? "bg-indigo-500 text-white border-indigo-500"
                              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                          }`}
                        >
                          {d}
                        </button>
                      );
                    })}
                    {schedDomains.length > 0 && (
                      <button
                        onClick={() => setSchedDomains([])}
                        className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>

                {/* 平台选择 */}
                <div className="space-y-1.5">
                  <div className="text-sm text-gray-700">
                    抓取平台
                    <span className="text-gray-300">（至少选 1 个）</span>
                  </div>
                  {/* 平台池已扩到 33 个：限高滚动，避免撑爆定时任务弹窗 */}
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto pr-1">
                    {PLATFORMS.map((p) => {
                      const on = schedPlatforms.includes(p);
                      return (
                        <button
                          key={p}
                          onClick={() => toggleSchedPlatform(p)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition ${
                            on
                              ? "bg-emerald-600 text-white border-emerald-600"
                              : "bg-white text-gray-600 border-gray-200 hover:border-emerald-300"
                          }`}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
                </div>
              </div>
            )}

            {schedMsg && (
              <div
                className={`text-xs ${
                  schedMsg.ok ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {schedMsg.text}
              </div>
            )}
            </div>

            {/* 底部固定：删除任务 / 编辑 / 保存（不随内容滚动） */}
            <div className="shrink-0 border-t border-gray-100 px-5 py-3">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSchedConfirmDelete(true)}
                  disabled={schedBusy}
                  className="text-sm px-3 py-1.5 rounded-lg border text-gray-400 hover:text-red-500 hover:border-red-300 disabled:opacity-50 transition"
                >
                  删除任务
                </button>
                {schedEditMode ? (
                  <button
                    onClick={saveSchedule}
                    disabled={schedBusy}
                    className="text-sm px-6 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition ml-auto"
                  >
                    {schedBusy ? "处理中…" : "保存"}
                  </button>
                ) : (
                  <button
                    onClick={() => setSchedEditMode(true)}
                    className="text-sm px-6 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition ml-auto"
                  >
                    编辑
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除定时任务二次确认 */}
      {schedConfirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSchedConfirmDelete(false)}
          />
          <div className="relative z-10 w-full max-w-xs bg-white rounded-2xl shadow-softer p-5 space-y-4">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">删除定时任务</div>
              <p className="text-sm text-gray-500 leading-relaxed">
                确定删除当前定时任务吗？删除后配置将被清空，此操作不可撤销。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSchedConfirmDelete(false)}
                disabled={schedBusy}
                className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
              >
                取消
              </button>
              <button
                onClick={deleteScheduleCfg}
                disabled={schedBusy}
                className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition"
              >
                {schedBusy ? "处理中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 会话侧边栏 */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 w-72 max-w-[80%] h-full bg-white shadow-softer flex flex-col">
            <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
              <span className="font-bold text-gray-700">会话</span>
              <button
                onClick={createSession}
                className="text-xs text-indigo-600 border border-indigo-200 rounded-lg px-2 py-1 hover:bg-indigo-50 transition"
              >
                ＋ 新建
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sessions.map((s) => {
                const active = s.id === activeId;
                return (
                  <div
                    key={s.id}
                    onClick={() => switchSession(s.id)}
                    className={`group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition ${
                      active
                        ? "bg-indigo-50 text-indigo-700"
                        : "hover:bg-gray-100 text-gray-700"
                    }`}
                  >
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameInput}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") {
                            setRenamingId(null);
                            setRenameInput("");
                          }
                        }}
                        onBlur={commitRename}
                        className="flex-1 min-w-0 text-sm border border-indigo-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    ) : (
                      <span className="flex-1 min-w-0 truncate text-sm">
                        {s.title}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(s);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-600 transition text-xs shrink-0"
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(s);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition text-xs shrink-0"
                      title="删除"
                    >
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white/75 backdrop-blur-xl border-b border-gray-100 px-4 py-3 shadow-sm space-y-2 shrink-0 pt-[max(0.75rem,env(safe-area-inset-top))] z-30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-gray-500 hover:text-indigo-600 transition text-lg leading-none px-1 shrink-0"
              title="会话列表"
            >
              ☰
            </button>
            <span className="flex items-center gap-2 min-w-0">
              <span className="h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white grid place-items-center text-sm font-bold shadow-sm shadow-indigo-200/60 shrink-0">
                热
              </span>
              <span className="text-base sm:text-lg font-bold whitespace-nowrap tracking-tight text-gray-900">
                热点抓取 Agent
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* 顶部选择区滚出视野后：领域 / 平台 收成下拉入口 */}
            {!selectorsVisible && (
              <>
                {/* PC：两个下拉，带数字 */}
                <div className="hidden sm:flex items-center gap-1.5 min-w-0">
                  <div className="relative">
                    <button
                      onClick={() =>
                        setOpenMenu(openMenu === "domain" ? null : "domain")
                      }
                      className={`text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition bg-gradient-to-br from-indigo-500 to-violet-500 text-white border-transparent shadow-md shadow-indigo-200/60 ${
                        openMenu === "domain" ? "ring-2 ring-violet-300" : ""
                      }`}
                    >
                      领域 ▾
                    </button>
                    {openMenu === "domain" && (
                      <div className="absolute right-0 top-full mt-2 z-30 w-72 max-w-[80vw] bg-white border rounded-xl shadow-soft p-3">
                        {renderDomainHeader()}
                        {renderDomainChips(true)}
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <button
                      onClick={openPlatformPicker}
                      className="text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition bg-gradient-to-br from-indigo-500 to-violet-500 text-white border-transparent shadow-md shadow-indigo-200/60 hover:opacity-90"
                    >
                      平台 {selectedPlatforms.length}/{MAX_PLATFORMS} ▾
                    </button>
                  </div>
                </div>

                {/* 移动端：一个合并下拉，不显示数字 */}
                <div className="relative flex sm:hidden min-w-0">
                  <button
                    onClick={() =>
                      setOpenMenu(openMenu === "both" ? null : "both")
                    }
                    className={`text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition bg-gradient-to-br from-indigo-500 to-violet-500 text-white border-transparent shadow-md shadow-indigo-200/60 ${
                      openMenu === "both" ? "ring-2 ring-violet-300" : ""
                    }`}
                  >
                    领域 / 平台 ▾
                  </button>
                  {openMenu === "both" && (
                    <div className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 bg-white border rounded-xl shadow-soft p-3 space-y-3">
                      <div>
                        {renderDomainHeader()}
                        {renderDomainChips(true)}
                      </div>
                      <div className="border-t pt-3">
                        <button
                          onClick={() => {
                            setOpenMenu(null);
                            openPlatformPicker();
                          }}
                          className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-indigo-300 transition"
                        >
                          <span>
                            选择抓取平台
                            <span className="text-gray-400 ml-1">
                              （已选 {selectedPlatforms.length}/{MAX_PLATFORMS}）
                            </span>
                          </span>
                          <span className="text-gray-400">›</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="relative">
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                className={`text-xs border rounded-lg px-2 py-1 transition ${
                  syncCode
                    ? "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                    : "text-gray-500 border-gray-200 hover:text-indigo-600 hover:border-indigo-300"
                }`}
                title="设置（同步 / 定时任务）"
              >
                ⚙️ 设置
              </button>
              {settingsOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setSettingsOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-50 w-40 bg-white border rounded-xl shadow-soft py-1 text-sm">
                    <button
                      onClick={() => {
                        setSettingsOpen(false);
                        setSyncMsg(null);
                        setShowSync(true);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-700"
                    >
                      🔄 同步{syncCode ? "（已启用）" : ""}
                    </button>
                    <button
                      onClick={openSchedule}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-700"
                    >
                      ⏰ 定时任务
                    </button>
                    <button
                      onClick={openLlmSettings}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-700"
                    >
                      🤖 AI 模型{llmSaved?.apiKey ? "（自定义）" : ""}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 下拉菜单点击外部关闭 */}
      {openMenu && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setOpenMenu(null)}
        />
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-4 pb-36">
        <div className="max-w-[57.6rem] mx-auto w-full space-y-4">
          {/* 顶部完整选择区：滚出视野后才在标题栏出现下拉入口 */}
          <div ref={selectorsRef} className="space-y-2 rounded-2xl border border-gray-100 bg-white/70 backdrop-blur-xl p-3.5 shadow-soft">
            <div>
              {renderDomainHeader()}
              {renderDomainChips(selectorsVisible)}
            </div>
            <div>
              {renderPlatformEntry()}
            </div>
          </div>
          {messages.map((msg, i) => {
            const isWelcome = msg.content === WELCOME.content;
            const isUser = msg.role === "user";
            const checked = selectedMsgs.includes(i);
            // 超时/失败的请求：左对齐卡片（宽度与普通助手气泡一致）+ 右对齐按钮行
            if (msg.failed) {
              return (
                <div key={`${i}-f${msg.flashNonce ?? 0}`} className="flex items-start gap-2">
                  {selectMode && !isWelcome && (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(i)}
                      className="mt-3 h-4 w-4 shrink-0 accent-indigo-500 cursor-pointer"
                    />
                  )}
                  <div
                    className={`flex-1 min-w-0 rounded-2xl bg-white border shadow-sm px-4 py-3 ${
                      msg.flashNonce ? "fail-shake" : ""
                    }`}
                  >
                    <div className="text-sm text-gray-500 leading-relaxed text-left">{msg.content}</div>
                    <div className="mt-2 flex flex-nowrap justify-end gap-2">
                      {msg.llmError
                        ? renderLlmActionButtons(msg.llmError, {
                            // 脚本生成失败的引导卡不挂聊天重试（会重发上一轮对话）
                            retry: msg.kind === "script" ? undefined : retryChat,
                          })
                        : (
                    <button
                      onClick={retryChat}
                      disabled={loading}
                      className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-600 text-xs font-medium px-3 py-1 hover:bg-indigo-100 transition disabled:opacity-50 whitespace-nowrap"
                    >
                      {retrying ? (
                        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-9-9" /></svg>
                      ) : (
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                      )}
                      {retrying ? "重试中…" : "重试"}
                    </button>
                        )}
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="flex items-start gap-2">
                {selectMode &&
                  (isWelcome ? (
                    <div className="w-4 shrink-0" />
                  ) : (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(i)}
                      className="mt-3 h-4 w-4 shrink-0 accent-indigo-500 cursor-pointer"
                    />
                  ))}
                <div
                  className={`group/msg flex flex-1 min-w-0 flex-col ${
                    isUser ? "items-end" : "items-start"
                  }`}
                >
                  {/* 用户消息上方标注本轮锁定的领域，切换领域后当轮回答即可直观区分 */}
                  {isUser && msg.domains && msg.domains.length > 0 && (
                    <div className="mb-1 flex flex-wrap justify-end gap-1">
                      {msg.domains.map((d) => (
                        <span
                          key={d}
                          className="rounded-full bg-indigo-50 text-indigo-600 text-[10px] px-2 py-0.5 border border-indigo-200"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    onClick={
                      selectMode && !isWelcome ? () => toggleSelect(i) : undefined
                    }
                    onTouchStart={(e) => startLongPress(i, e)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    onTouchCancel={cancelLongPress}
                    className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                      isUser
                        ? "max-w-[85%] bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-200/60"
                        : isWelcome
                        ? "max-w-[85%] bg-white text-gray-800 shadow-sm border"
                        : "w-full bg-white text-gray-800 shadow-sm border"
                    } ${selectMode && !isWelcome ? "cursor-pointer select-none" : ""}`}
                  >
                    {msg.toolLogs && msg.toolLogs.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5 border-b pb-2">
                        {msg.toolLogs.map((log, j) => (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-500 text-xs px-2.5 py-0.5 border border-gray-200"
                          >
                            🔧 {log}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className={selectMode ? "pointer-events-none" : ""}>
                      {msg.role === "assistant" && !isWelcome ? (
                        msg.kind === "script" ? (
                          <div className="whitespace-pre-wrap leading-relaxed">
                            {cleanMarkdown(msg.content)}
                          </div>
                        ) : (
                          renderAssistantContent(msg.content, i, msg.refs)
                        )
                      ) : (
                        msg.content
                      )}
                    </div>
                  </div>
                  {/* 多领域·未搜到领域的独立气泡：与回答同侧(左)、堆叠在下方，互不重叠 */}
                  {msg.role === "assistant" && msg.emptyNote && (
                    <div className="mt-2 max-w-[85%] rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-700 shadow-sm">
                      {msg.emptyNote}
                    </div>
                  )}
                  {/* AI 输出端工具栏常驻；用户输出端悬浮才显示。点删除唤起编辑态 */}
                  {!selectMode && !isWelcome && (
                    <div
                      className={`mt-1 flex gap-1 transition ${
                        isUser
                          ? "max-sm:opacity-100 opacity-0 group-hover/msg:opacity-100"
                          : "opacity-100"
                      }`}
                    >
                      <button
                        onClick={() => copyMessage(msg.content, i)}
                        title={copiedIdx === i ? "已复制" : "复制"}
                        className={`rounded p-1 transition ${
                          copiedIdx === i
                            ? "text-emerald-500"
                            : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                        }`}
                      >
                        {copiedIdx === i ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        ) : (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        )}
                      </button>
                      {/* 定时专属会话：抓取报告可一键导入新会话继续聊 */}
                      {activeId === "scheduled" &&
                        !msg.content.startsWith("⏰") && (
                          <button
                            onClick={() => importSchedToNewSession(i)}
                            title="把这条抓取结果导入新会话继续聊"
                            className="text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded p-1 transition"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
                          </button>
                        )}
                      <button
                        onClick={() => enterSelectMode(i)}
                        title="删除"
                        className="text-gray-400 hover:text-red-500 hover:bg-red-50 rounded p-1 transition"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex justify-end">
              <div className="thinking-bubble bg-white rounded-2xl px-4 py-3 text-sm shadow-sm border">
                <span className="thinking-text">思考中</span>
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Quick Actions：悬浮在输入栏上方，无背景，内容从按钮周围透出 */}
      <div className="relative shrink-0 z-10">
      {!selectMode && (
      <div className="absolute left-0 right-0 bottom-full px-4 pb-2 pointer-events-none">
        <div className="max-w-[57.6rem] mx-auto w-full flex flex-wrap gap-2 pointer-events-auto">
          {[
            { label: "帮我抓取今日热点", prompt: "帮我抓取今日热点", send: true },
            { label: "根据领域筛选热点", prompt: "根据XX领域筛选热点", send: false },
          ].map((q) => (
            <button
              key={q.label}
              disabled={loading}
              onClick={() => {
                if (q.send) {
                  sendMessage(q.prompt);
                } else {
                  setInput(q.prompt);
                  inputRef.current?.focus();
                }
              }}
              className="text-xs bg-white text-indigo-600 px-3 py-1.5 rounded-full border border-gray-200 hover:border-indigo-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Input / 编辑态删除栏 */}

      {selectMode ? (
        <div className="border-t bg-white px-4 py-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3 max-w-[57.6rem] mx-auto">
            <span className="text-sm text-gray-500">
              已选 {selectedMsgs.length} 条
            </span>
            <div className="flex-1" />
            <button
              onClick={exitSelectMode}
              className="px-4 py-2 rounded-lg text-sm border text-gray-600 hover:bg-gray-50 transition"
            >
              取消
            </button>
            <button
              onClick={deleteSelected}
              disabled={selectedMsgs.length === 0}
              className="bg-red-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              删除
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t bg-white px-4 py-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex gap-2 max-w-[57.6rem] mx-auto">
            <input
              ref={inputRef}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 transition"
              placeholder="输入你的需求，例如：帮我看看今天有什么热点"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
              disabled={loading}
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              发送
            </button>
          </div>
        </div>
      )}
      </div>
    </main>
  );
}
