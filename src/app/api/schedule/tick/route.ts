import { NextResponse } from "next/server";
import { runDueSchedules } from "@/lib/scheduler";

// 手动/外部触发一次调度检查（进程内定时器之外的兜底入口）。
// VPS 上 instrumentation.ts 的每分钟定时器是主驱动；此路由便于本地/外部 cron 兜底。
export async function POST() {
  try {
    await runDueSchedules();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: `${e?.message || e}` }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
