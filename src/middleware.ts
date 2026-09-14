// 中间件（2026-09 改为公开站点 + 强制 BYOK）：
// 站点不设访问口令，任何人都能直接打开页面；"没填自己的 API Key 不能用"由各
// API 路由在服务端强制（见 lib/llm.ts 的 resolveRequestLlm：访客无 Key 一律拒绝，
// 只有带 X-Internal-Token 的系统内部调用才允许使用系统 Key）。
//
// 这里只保留一道闸：外部 cron 兜底入口 /api/schedule/tick 必须持内部令牌。
// （定时抓取的主驱动是进程内定时器，它直接 import chat POST，不经 HTTP/中间件。）
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname !== "/api/schedule/tick")
    return NextResponse.next();

  const expected = process.env.INTERNAL_TOKEN;
  const got = req.headers.get("x-internal-token");
  if (expected && got === expected) return NextResponse.next();
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// 只拦 cron 兜底入口，其余请求零中间件开销
export const config = {
  matcher: ["/api/schedule/tick"],
};
