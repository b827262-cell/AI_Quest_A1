import { z } from "zod";

/**
 * Public homepage configuration. These values are deliberately kept separate
 * from the admin appearance settings so the public API can expose only the
 * fields that are safe for an unauthenticated browser.
 */
const safeText = (max: number, fallback: string) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/<\s*\/?\s*[a-z][^>]*>/i.test(value), "HTML / script markup is not allowed")
    .default(fallback);

export const siteConfigSchema = z.object({
  siteTitle: safeText(80, "AI-SmartBook"),
  siteSubtitle: safeText(160, "多模型領域智慧解題平台"),
  homeGreeting: safeText(100, "今天想學習什麼？"),
  homeInputPlaceholder: safeText(120, "輸入你的問題……"),
  guestAiEnabled: z.boolean().default(true),
  guestDailyLimit: z.number().int().min(0).max(100).default(3),
  studentLoginEnabled: z.boolean().default(true),
  maintenanceNotice: safeText(240, "")
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const DEFAULT_SITE_CONFIG: SiteConfig = siteConfigSchema.parse({});

export const siteConfigUpdateSchema = siteConfigSchema.partial();
export type SiteConfigUpdate = z.infer<typeof siteConfigUpdateSchema>;

/** Safe subset returned to unauthenticated clients. */
export const publicSiteConfigSchema = siteConfigSchema.pick({
  siteTitle: true,
  siteSubtitle: true,
  homeGreeting: true,
  homeInputPlaceholder: true,
  guestAiEnabled: true,
  guestDailyLimit: true,
  studentLoginEnabled: true,
  maintenanceNotice: true
});
export type PublicSiteConfig = z.infer<typeof publicSiteConfigSchema>;
