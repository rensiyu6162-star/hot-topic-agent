import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "热点抓取 Agent",
  description: "自媒体热点抓取与视频脚本生成",
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
