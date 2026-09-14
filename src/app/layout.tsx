import type { Metadata, Viewport } from "next";
import "./globals.css";

// 强制动态 SSR：静态预渲染页 Next 会强制下发 Cache-Control: s-maxage=31536000，
// 旧 HTML 被缓存一年，导致每次部署后用户仍加载旧界面（见 next.config.js 注释）。
// 本页是 "use client" 单页、SSR 成本极低，动态渲染后 HTML 每次回源校验。
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "热点抓取 Agent",
  description: "自媒体热点抓取与视频脚本生成",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
