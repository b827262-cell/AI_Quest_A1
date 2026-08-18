import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-SmartBook｜AI 智慧學習工作台",
  description:
    "以 AI 問答、智慧書庫與學習進度，陪你把每一次閱讀變成可累積的成長。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
