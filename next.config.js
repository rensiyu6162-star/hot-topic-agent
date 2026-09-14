/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    instrumentationHook: true,
  },
  // 页面 HTML 默认会带 s-maxage=31536000，旧 HTML 被浏览器/移动网络代理缓存后，
  // 新版本上线用户仍拿到旧 HTML + 旧 chunk（hash 资源也被缓存一年），表现为
  // "明明部署了却永远是旧界面"。页面与接口强制每次回源校验；_next/static 带哈希，
  // 不匹配此规则、继续走永久缓存。
  async headers() {
    return [
      {
        source: "/:path((?!_next/).*)",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
