export type SyncDecision = "insert" | "update" | "skip" | "conflict";

export type SyncMetadata = {
  sourceSystem: string;
  sourceRecordId: string;
  sourceUpdatedAt: string;
  syncVersion: number;
  checksum: string;
};

const FORBIDDEN_KEYS = /password|password_hash|session|api[_-]?key|secret|token|credential/i;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => !FORBIDDEN_KEYS.test(key)).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? value
      : new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sourceVersion(updatedAt: string | undefined, explicit?: number): number {
  if (Number.isInteger(explicit) && Number(explicit) >= 0) return Number(explicit);
  const parsed = Date.parse(updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function decideSync(incoming: SyncMetadata, current: SyncMetadata | null): SyncDecision {
  if (!current) return "insert";
  if (incoming.syncVersion > current.syncVersion) return "update";
  if (incoming.syncVersion < current.syncVersion) return "skip";
  return incoming.checksum === current.checksum ? "skip" : "conflict";
}

export function stableTargetId(entityType: string, sourceSystem: string, sourceRecordId: string): string {
  return `sync-${entityType}-${sourceSystem}-${sourceRecordId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
}

export function isSafeSource(source: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source);
}
