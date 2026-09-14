import { NextResponse } from "next/server";
import { SOURCE_HEALTH } from "../../../lib/sourceHealth";

// ⚠️ 必须强制动态：GET handler 未使用 request 对象时，Next 14 会在 build 期静态化该路由，
// 之后永远返回构建时刻的空快照（platforms:[]），进程内实时记录永远透不出来。
export const dynamic = "force-dynamic";

// 数据源健康体检（阶段3 故障可视化）：
// 读取各平台抓取时的内存健康记录（进程内，重启清零，仅供调试/告警）。
// 无鉴权、无副作用，仅返回上次抓取后各平台各数据源的成功/失败明细。
export async function GET() {
  const now = Date.now();
  const entries = Object.entries(SOURCE_HEALTH).map(([platform, list]) => ({
    platform,
    checkedAt: now,
    okCount: list.filter((e) => e.ok).length,
    failCount: list.filter((e) => !e.ok).length,
    sources: list.map((e) => ({
      source: e.source,
      ok: e.ok,
      error: e.error || null,
      at: new Date(e.at).toISOString(),
    })),
  }));
  return NextResponse.json({
    at: new Date(now).toISOString(),
    note: "进程内健康记录，重启后清零；未抓取过的平台不会出现",
    platforms: entries,
  });
}
