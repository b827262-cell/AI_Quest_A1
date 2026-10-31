import type { LearningSourceType } from "../../learningHistory";
import type { GuestQuestionCategory, PublicSiteConfig } from "../../studentClient";

export const DEFAULT_CONFIG: PublicSiteConfig = {
  siteTitle: "iBrain AI",
  siteSubtitle: "多模型領域智慧解題平台",
  homeGreeting: "今天想學習什麼？",
  homeInputPlaceholder: "輸入你的問題……",
  guestAiEnabled: true,
  guestDailyLimit: 3,
  studentLoginEnabled: true,
  maintenanceNotice: ""
};

export const QUICK_STARTS: Array<{ label: string; category: GuestQuestionCategory; question: string }> = [
  { label: "程式設計", category: "programming", question: "如何把一個複雜的程式問題拆成小步驟？" },
  { label: "數學解題", category: "math", question: "數學題目要怎麼整理已知條件？" },
  { label: "教材問答", category: "教材問答", question: "請示範如何從教材整理一個重點。" },
  { label: "資通安全", category: "cybersecurity", question: "Reflected XSS 是否能讀取其他網站的 Cookie？" }
];

export const SOURCE_LABELS: Record<LearningSourceType, string> = {
  manual: "手動輸入",
  image: "圖片",
  file: "文件"
};
