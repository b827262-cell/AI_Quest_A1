const ADMIN_API_ORIGIN = normalizeOrigin(import.meta.env.VITE_ADMIN_API_ORIGIN);

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : undefined;
}

/** Resolve the Admin API while preserving Vite's relative local proxy paths. */
export function resolveAdminApiUrl(path: string): string {
  if (!ADMIN_API_ORIGIN || !import.meta.env.PROD) return path;
  return new URL(path, `${ADMIN_API_ORIGIN}/`).toString();
}
