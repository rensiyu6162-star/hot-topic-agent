import { NextRequest, NextResponse } from "next/server";
import { kvConfigured } from "@/lib/kv-config";

// 懒加载本地 KV（eval("require") + 绝对路径，绕开 Next.js Webpack）
let _kvFn: any = null;
function getKvFn() {
  if (!_kvFn) {
    // eslint-disable-next-line no-eval
    const _require = eval("require");
    _kvFn = _require(process.cwd() + "/src/server/kv.js").kv;
  }
  return _kvFn;
}
async function kv(...args: any[]): Promise<any> {
  return getKvFn()(...args);
}

// 跨设备同步：以「同步码」为 key，把整包会话/设置数据存到本地文件 KV。
// 服务端仅做转发，不额外保存。任何持有同步码的人都能读写该码下的数据，属共享密钥。

// 90 天无写入则过期，每次上传都会刷新
const TTL_SECONDS = 60 * 60 * 24 * 90;

// 同步码格式校验：仅允许字母数字与短横线，长度 8~64
const CODE_RE = /^[A-Za-z0-9-]{8,64}$/;

function keyOf(code: string) {
  return `sync:${code}`;
}

function notConfigured() {
  return NextResponse.json(
    { error: "服务端存储未就绪，请稍后重试。" },
    { status: 503 }
  );
}

// 拉取：GET /api/sync?code=xxx
export async function GET(req: NextRequest) {
  if (!kvConfigured()) return notConfigured();
  const code = (req.nextUrl.searchParams.get("code") || "").trim();
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "同步码格式不正确" }, { status: 400 });
  }
  try {
    const raw = await kv(["GET", keyOf(code)]);
    if (raw == null) {
      return NextResponse.json({ error: "该同步码下暂无数据" }, { status: 404 });
    }
    // 存的是一个 JSON 字符串 { payload, updatedAt }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { payload: raw, updatedAt: 0 };
    }
    return NextResponse.json({
      payload: parsed.payload ?? null,
      updatedAt: parsed.updatedAt ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `拉取失败: ${e.message}` }, { status: 500 });
  }
}

// 上传：POST /api/sync  { code, payload }
export async function POST(req: NextRequest) {
  if (!kvConfigured()) return notConfigured();
  try {
    const { code, payload } = await req.json();
    const c = (code || "").trim();
    if (!CODE_RE.test(c)) {
      return NextResponse.json({ error: "同步码格式不正确" }, { status: 400 });
    }
    if (payload == null) {
      return NextResponse.json({ error: "缺少 payload" }, { status: 400 });
    }
    const updatedAt = Date.now();
    const value = JSON.stringify({ payload, updatedAt });
    // 单包体积保护：超过 ~2MB 拒绝，避免异常数据撑爆 KV
    if (value.length > 2 * 1024 * 1024) {
      return NextResponse.json({ error: "数据过大，无法同步" }, { status: 413 });
    }
    await kv(["SET", keyOf(c), value, "EX", TTL_SECONDS]);
    return NextResponse.json({ ok: true, updatedAt });
  } catch (e: any) {
    return NextResponse.json({ error: `上传失败: ${e.message}` }, { status: 500 });
  }
}
