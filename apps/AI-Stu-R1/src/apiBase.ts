const STUDENT_API_ORIGIN = normalizeOrigin(import.meta.env.VITE_STUDENT_API_ORIGIN);
const ADMIN_API_ORIGIN = normalizeOrigin(import.meta.env.VITE_ADMIN_API_ORIGIN);
const FLOW_API_ORIGIN = normalizeOrigin(import.meta.env.VITE_FLOW_API_ORIGIN);

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : undefined;
}

function resolve(path: string, origin: string | undefined): string {
  if (!origin || !import.meta.env.PROD) return path;
  return new URL(path, `${origin}/`).toString();
}

/** Resolve the standalone Student API without changing local Vite proxy paths. */
export function resolveStudentApiUrl(path: string): string {
  return resolve(path, STUDENT_API_ORIGIN);
}

/** Resolve central public/read routes that are owned by the Admin API. */
export function resolveStudentAdminApiUrl(path: string): string {
  return resolve(path, ADMIN_API_ORIGIN);
}

/** Resolve the optional AntiG institutional-flow sidecar in production. */
export function resolveStudentFlowApiUrl(path: string): string {
  return resolve(path, FLOW_API_ORIGIN);
}
