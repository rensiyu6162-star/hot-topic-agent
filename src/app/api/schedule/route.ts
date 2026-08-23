import { NextRequest, NextResponse } from "next/server";
import {
  getSchedule,
  saveSchedule,
  deleteSchedule,
  normalizeConfig,
  cstToday,
} from "@/lib/scheduler";
import { kvConfigured } from "@/lib/kv";

// 定时任务配置：以「同步码」为身份。
// GET  /api/schedule?code=xxx        → 返回当前配置（无则 null）
// POST /api/schedule { code, ...cfg } → 规范化并保存；enabled=false 时仅停用，删除用 DELETE
// DELETE /api/schedule { code }       → 删除配置

const CODE_RE = /^[A-Za-z0-9-]{8,64}$/;

function notConfigured() {
  return NextResponse.json(
    { error: "服务端未配置云端存储（KV），无法使用定时任务。" },
    { status: 503 }
  );
}

export async function GET(req: NextRequest) {
  if (!kvConfigured()) return notConfigured();
  const code = (req.nextUrl.searchParams.get("code") || "").trim();
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "同步码格式不正确" }, { status: 400 });
  }
  try {
    const cfg = await getSchedule(code);
    return NextResponse.json({ config: cfg });
  } catch (e: any) {
    return NextResponse.json({ error: `读取失败: ${e.message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!kvConfigured()) return notConfigured();
  try {
    const body = await req.json();
    const code = (body?.code || "").trim();
    if (!CODE_RE.test(code)) {
      return NextResponse.json({ error: "同步码格式不正确" }, { status: 400 });
    }
    const result = normalizeConfig(body, cstToday());
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    await saveSchedule(code, result);
    return NextResponse.json({ ok: true, config: result });
  } catch (e: any) {
    return NextResponse.json({ error: `保存失败: ${e.message}` }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!kvConfigured()) return notConfigured();
  try {
    const body = await req.json().catch(() => ({}));
    const code = (body?.code || req.nextUrl.searchParams.get("code") || "").trim();
    if (!CODE_RE.test(code)) {
      return NextResponse.json({ error: "同步码格式不正确" }, { status: 400 });
    }
    await deleteSchedule(code);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: `删除失败: ${e.message}` }, { status: 500 });
  }
}
