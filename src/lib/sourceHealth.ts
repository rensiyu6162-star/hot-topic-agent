// ========== 数据源健康记录（进程内，重启清零；仅供调试 / 告警用） ==========
// 阶段3 故障可视化：每个平台抓取时，各数据源的成功/失败都会记到这里，
// /api/health 路由直接读它，让"哪个源挂了、为什么挂"一眼可见。
export type SourceHealthEntry = {
  source: string;
  ok: boolean;
  error: string;
  at: number;
};

// ⚠️ 必须挂 globalThis：Next.js 生产构建会把 lib 模块内联进各 route bundle，
// 模块级变量在 chat 与 /api/health 各有一份实例（chat 写A份、health 读B份，永远空）。
// 挂到 globalThis 后全进程共享同一对象，health 才能看到 chat 写入的记录。
const g = globalThis as unknown as {
  __HT_SOURCE_HEALTH__?: Record<string, SourceHealthEntry[]>;
};
export const SOURCE_HEALTH: Record<string, SourceHealthEntry[]> =
  (g.__HT_SOURCE_HEALTH__ ??= {});

export function recordSourceHealth(platformKey: string, entries: SourceHealthEntry[]): void {
  if (entries.length) SOURCE_HEALTH[platformKey] = entries;
}
