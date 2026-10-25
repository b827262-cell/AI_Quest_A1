export type AdminUser = { id: string; email: string; displayName: string };
export type AdminIdentityState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "authorized"; user: AdminUser };

export async function resolveAdminIdentity(response: Response): Promise<AdminIdentityState> {
  if (response.status === 401) return { status: "unauthenticated" };
  if (response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "error" };

  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return { status: "error" };
    const value = data as Record<string, unknown>;
    if (value.authenticated !== true || value.role !== "admin") return { status: "error" };
    const user = value.user;
    if (!user || typeof user !== "object") return { status: "error" };
    const fields = user as Record<string, unknown>;
    if (typeof fields.id !== "string" || !fields.id ||
        typeof fields.email !== "string" || !fields.email ||
        typeof fields.displayName !== "string" || !fields.displayName) return { status: "error" };
    return { status: "authorized", user: {
      id: fields.id, email: fields.email, displayName: fields.displayName,
    } };
  } catch {
    return { status: "error" };
  }
}

export async function readAdminIdentity(signal: AbortSignal): Promise<AdminIdentityState> {
  try {
    const response = await fetch("/api/admin/auth/me", {
      method: "GET", credentials: "same-origin", cache: "no-store", signal,
    });
    return resolveAdminIdentity(response);
  } catch {
    return { status: "error" };
  }
}
