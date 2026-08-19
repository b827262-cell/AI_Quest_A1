const ADMIN_API_ORIGIN = normalizeOrigin(import.meta.env.VITE_ADMIN_API_ORIGIN);

// Hostnames whose Sites Worker proxies /api/admin/* to the Admin API itself
// (same-origin from the browser's perspective), so the SPA must keep using
// relative paths here even though VITE_ADMIN_API_ORIGIN is baked into this
// shared production bundle for other deployment targets.
const SAME_ORIGIN_PROXY_HOSTNAMES = new Set(["ai-quest-a1-admin.b827262.chatgpt.site"]);

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : undefined;
}

/** Resolve the Admin API while preserving Vite's relative local proxy paths. */
export function resolveAdminApiUrl(path: string): string {
  if (!ADMIN_API_ORIGIN || !import.meta.env.PROD) return path;
  if (typeof window !== "undefined" && SAME_ORIGIN_PROXY_HOSTNAMES.has(window.location.hostname)) {
    return path;
  }
  return new URL(path, `${ADMIN_API_ORIGIN}/`).toString();
}
