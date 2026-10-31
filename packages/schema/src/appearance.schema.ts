import { z } from "zod";

/**
 * Admin-configurable appearance settings for the admin shell and the student
 * homepage banner. Numeric fields are pixel values. Every field has a default
 * so the UI never blanks out when settings are missing.
 */
export const appearanceSettingsSchema = z.object({
  // Navigation
  dashboardNavLabel: z.string().default("首頁"),
  // Header / brand
  systemName: z.string().default("iBrain AI"),
  headerLogoUrl: z.string().default(""),
  headerLogoSize: z.number().int().min(8).max(96).default(24),
  headerLogoTextGap: z.number().int().min(0).max(48).default(8),
  // Banner / hero
  bannerTitle: z.string().default("iBrain 智能學習夥伴"),
  bannerSubtitle: z.string().default("書籍・課程・測驗一站搞定"),
  bannerIconUrl: z.string().default(""),
  bannerIconSize: z.number().int().min(8).max(160).default(36),
  bannerIconTitleGap: z.number().int().min(0).max(64).default(12),
  bannerPaddingTop: z.number().int().min(0).max(200).default(32),
  bannerPaddingBottom: z.number().int().min(0).max(200).default(32),
  bannerMaxWidth: z.number().int().min(320).max(1600).default(720),
  searchPlaceholder: z.string().default("搜尋科目、老師名稱..."),
  assistantButtonText: z.string().default("iBrain 助教群"),

  // --- Student homepage layout (A. Hero) ---
  studentHeroVariant: z.enum(["compact", "card"]).default("compact"),
  studentHeroShowCard: z.boolean().default(false),
  studentHeroPaddingTop: z.number().int().min(0).max(120).default(28),
  studentHeroPaddingBottom: z.number().int().min(0).max(120).default(28),
  studentHeroTitleFontSize: z.number().int().min(12).max(48).default(24),
  studentHeroSubtitleFontSize: z.number().int().min(12).max(48).default(14),
  studentHeroSearchMaxWidth: z.number().int().min(480).max(1440).default(680),
  studentHeroSearchHeight: z.number().int().min(28).max(80).default(40),
  assistantButtonVisible: z.boolean().default(true),
  studentHeroTextAlign: z.enum(["left", "center"]).default("center"),

  // --- Student header: brand area ---
  studentHeaderBrandLogoUrl: z.string().default(""),
  studentHeaderBrandLogoSize: z.number().int().min(12).max(96).default(28),
  studentHeaderBrandText: z.string().default("iBrain AI"),
  studentHeaderBrandTextColor: z.string().default("#111827"),
  studentHeaderBrandFontSize: z.number().int().min(12).max(40).default(18),
  studentHeaderBrandGap: z.number().int().min(0).max(40).default(10),

  // --- Student header: background ---
  studentHeaderBackgroundColor: z.string().default("#ffffff"),
  studentHeaderBorderColor: z.string().default("#e5e7eb"),
  studentHeaderShadowEnabled: z.boolean().default(false),

  // --- Student header: home button ---
  studentHeaderHomeButtonLabel: z.string().default("首頁"),
  studentHeaderHomeButtonBg: z.string().default("#0b63d8"),
  studentHeaderHomeButtonTextColor: z.string().default("#ffffff"),
  studentHeaderHomeButtonRadius: z.number().int().min(0).max(999).default(999),
  studentHeaderHomeButtonHeight: z.number().int().min(24).max(64).default(34),
  studentHeaderHomeButtonHorizontalPadding: z.number().int().min(4).max(48).default(14),
  studentHeaderHomeButtonIconMode: z.enum(["default", "image"]).default("default"),
  studentHeaderHomeButtonIconUrl: z.string().default(""),
  studentHeaderHomeButtonIconSize: z.number().int().min(8).max(40).default(14),

  // --- Student homepage layout (B. Book list) ---
  studentContentMaxWidth: z.number().int().min(480).max(1440).default(864),
  studentCategoryGap: z.number().int().min(0).max(120).default(44),
  studentCategoryTitleFontSize: z.number().int().min(12).max(48).default(22),
  studentBookCardWidth: z.number().int().min(120).max(260).default(160),
  studentBookCoverHeight: z.number().int().min(140).max(360).default(214),
  studentBookGridGap: z.number().int().min(8).max(40).default(16),
  studentBookCardRadius: z.number().int().min(0).max(32).default(16),
  studentBookCoverFit: z.enum(["contain", "cover"]).default("contain"),
  studentFallbackCoverMode: z.enum(["simple", "gradient"]).default("simple"),

  // --- Student homepage layout (C. Category) ---
  categoryIcon: z.string().default("📚"),
  categoryCountSuffix: z.string().default("本"),
  showCategoryDivider: z.boolean().default(true),

  // --- Student homepage background (D. Page background) ---
  studentPageBackgroundMode: z.enum(["solid", "gradient", "image"]).default("solid"),
  studentPageBackgroundColor: z.string().default("#ffffff"),
  studentPageBackgroundGradientFrom: z.string().default("#ffffff"),
  studentPageBackgroundGradientTo: z.string().default("#ffffff"),
  studentPageBackgroundImageUrl: z.string().default(""),
  studentPageBackgroundImageFit: z.enum(["cover", "contain", "auto"]).default("cover"),
  studentPageBackgroundImagePosition: z.string().default("center top"),
  studentPageBackgroundImageRepeat: z.enum(["no-repeat", "repeat"]).default("no-repeat")
});

export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

/** Fully-populated defaults (parsing an empty object fills every field). */
export const DEFAULT_APPEARANCE: AppearanceSettings = appearanceSettingsSchema.parse({});

/** Partial update payload — any subset of fields may be sent. */
export const appearanceSettingsUpdateSchema = appearanceSettingsSchema.partial();
export type AppearanceSettingsUpdate = z.infer<typeof appearanceSettingsUpdateSchema>;
