// Bilibili 视频直搜（wbi 签名，2026-09 评测实证）。
// 背景：searxng 的 bilibili 引擎在服务器上被整体熔断（videos 类目全 0），导致详情页
// 「参考视频」长期只有搜索词兜底链接，产品硬规则"参考视频过少:0条"连环 FAIL。
// 实测 B站 wbi 搜索 API 在腾讯云 datacenter IP 上可用：只需先访问首页拿 buvid3 cookie、
// 再从 nav 接口取 img_key/sub_key 计算 mixin 签名，未登录（code -101）也能搜索（code 0）。
// 极敏感词会触发风控（返回 v_voucher 而非 result），此时返回空数组由调用方降级。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
  19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
  51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export type BiliVideo = {
  title: string;
  url: string;
  author: string;
  play: number;
  published?: string; // YYYY-MM-DD
};

type WbiCtx = {
  mixin: string;
  cookie: string;
};

let cachedCtx: { ctx: WbiCtx; at: number } | null = null;
const CTX_TTL = 30 * 60 * 1000;

async function buildCtx(): Promise<WbiCtx | null> {
  if (cachedCtx && Date.now() - cachedCtx.at < CTX_TTL) return cachedCtx.ctx;
  try {
    // 1. 首页拿 buvid3 / b_nut
    const home = await fetch("https://www.bilibili.com/", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = home.headers.getSetCookie?.() || [];
    const pairs = setCookie
      .map((c) => c.split(";")[0])
      .filter((c) => /^(buvid3|b_nut|buvid4)=/.test(c));
    const cookie = pairs.join("; ");

    // 2. nav 取 wbi keys
    const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Cookie: cookie },
      signal: AbortSignal.timeout(10000),
    });
    const nav = await navRes.json();
    const wbi = nav?.data?.wbi_img;
    if (!wbi?.img_url || !wbi?.sub_url) return null;
    const imgKey = wbi.img_url.split("/").pop()!.split(".")[0];
    const subKey = wbi.sub_url.split("/").pop()!.split(".")[0];
    const raw = imgKey + subKey;
    const mixin = MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
    const ctx = { mixin, cookie };
    cachedCtx = { ctx, at: Date.now() };
    return ctx;
  } catch {
    return null;
  }
}

async function md5Hex(s: string): Promise<string> {
  // Node 18+ 无全局 md5；用 Web Crypto 的 SHA-256 不行（wbi 要 MD5）。
  // 用 Node 内置 crypto（Next standalone 服务端可用）。
  const crypto = await import("crypto");
  return crypto.createHash("md5").update(s).digest("hex");
}

// 统一按北京时间（UTC+8）折算 YYYY-MM-DD：B站/抖音都是中文平台，发布日期展示口径
// 应为北京时间；显式 +8 偏移，不受服务器时区影响（本地开发可能是 UTC）。
function ymdCn(unix: number): string {
  return new Date((unix + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

// 批量查 B站视频发布日期（2026-09 参考视频补日期）：SearXNG 的 bilibili 引擎结果常不带
// publishedDate，而视频详情接口 x/web-interface/view 无需 wbi 签名、带 buvid cookie 即可
// 调（已实测 code=0），返回权威 pubdate。按 bvid 并行查询，失败/风控的单个跳过，不阻塞。
export async function biliVideoDates(
  bvids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(bvids.filter(Boolean))].slice(0, 12);
  if (!uniq.length) return out;
  const ctx = await buildCtx();
  if (!ctx) return out;
  await Promise.all(
    uniq.map(async (bvid) => {
      try {
        const res = await fetch(
          `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
          {
            headers: {
              "User-Agent": UA,
              Referer: `https://www.bilibili.com/video/${bvid}`,
              Cookie: ctx.cookie,
            },
            signal: AbortSignal.timeout(8000),
          }
        );
        const json = await res.json();
        if (json?.code === 0 && json?.data?.pubdate) {
          out.set(bvid, ymdCn(Number(json.data.pubdate)));
        }
      } catch {
        /* 单个失败跳过 */
      }
    })
  );
  return out;
}

export async function biliSearchVideos(
  keyword: string,
  limit = 6
): Promise<BiliVideo[]> {
  const ctx = await buildCtx();
  if (!ctx || !keyword.trim()) return [];
  try {
    const params: Record<string, string | number> = {
      search_type: "video",
      keyword: keyword.trim(),
      page: 1,
      order: "totalrank",
      wts: Math.floor(Date.now() / 1000),
    };
    const qs = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
      .join("&");
    const wRid = await md5Hex(qs + ctx.mixin);
    const url =
      "https://api.bilibili.com/x/web-interface/wbi/search/type?" +
      qs +
      `&w_rid=${wRid}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://search.bilibili.com/",
        Cookie: ctx.cookie,
      },
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json();
    if (json?.code !== 0) return [];
    const result = json?.data?.result;
    if (!Array.isArray(result)) return []; // 风控（v_voucher）等
    return result
      .filter((v: any) => v && v.bvid && v.title)
      .slice(0, limit)
      .map((v: any) => ({
        title: String(v.title).replace(/<[^>]+>/g, "").trim(),
        url: `https://www.bilibili.com/video/${v.bvid}`,
        author: String(v.author || "").trim(),
        play: Number(v.play) || 0,
        published: v.pubdate ? ymdCn(Number(v.pubdate)) : undefined,
      }))
      .filter((v) => v.title.length > 0);
  } catch {
    return [];
  }
}
