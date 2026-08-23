// Next 14 instrumentation：进程启动时注册一个每分钟的定时器，驱动定时任务。
// 仅在 Node.js 运行时执行（排除 edge/浏览器）；VPS 上 Docker 常驻，关掉浏览器也能跑。
// Vercel Serverless 无常驻进程，此定时器实际不会持续运行——以 VPS 为准。

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 防止 HMR / 多次注册导致重复定时器
  const g = globalThis as any;
  if (g.__schedTimerStarted) return;
  g.__schedTimerStarted = true;

  const { runDueSchedules } = await import("./lib/scheduler");

  const tick = async () => {
    try {
      await runDueSchedules();
    } catch (e) {
      // 静默：单次失败不影响后续 tick
      console.error("[scheduler] tick error:", e);
    }
  };

  // 启动即跑一次（覆盖刚启动时错过的 catch-up 窗口），随后每分钟一次
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000);
  console.log("[scheduler] per-minute timer started");
}
