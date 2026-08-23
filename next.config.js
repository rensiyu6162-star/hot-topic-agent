/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // 启用 instrumentation.ts —— 进程内定时任务驱动（Next 14）
    instrumentationHook: true,
  },
};
module.exports = nextConfig;
