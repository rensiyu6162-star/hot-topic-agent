// Next 14 instrumentation：进程启动时注册一个每分钟的定时器，驱动定时任务。
// 仅在 Node.js 运行时执行（排除 edge/浏览器）；VPS 上 Docker 常驻，关掉浏览器也能跑。
//
// 关键设计：不走模块依赖（避免 Next.js Webpack/standalone 的各种打包问题），
// 而是直接 HTTP POST 到本容器的 /api/schedule/tick —— 让 Next.js 正常的路由编译来处理 scheduler 加载。

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as any;
  if (g.__schedTimerStarted) return;
  g.__schedTimerStarted = true;

  const tick = async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = process.env.INTERNAL_TOKEN;
      if (token) headers["x-internal-token"] = token;

      const res = await fetch("http://127.0.0.1:3000/api/schedule/tick", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        console.error("[scheduler] tick failed:", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.error("[scheduler] tick error:", e);
    }
  };

  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000);
  console.log("[scheduler] per-minute timer started (HTTP tick)");
}
