/** Pure edge configuration shared by the gate, secondary sender and health. */
export type EdgeGateMode = "accept" | "require";

export function readEdgeGateMode(value: unknown): EdgeGateMode {
  if (value === undefined || value === null) return "accept";
  if (typeof value !== "string") return "require";
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "accept" ? "accept" : "require";
}

export function isUsableEdgeSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 512;
}

/** Only the current secret for this site can be sent; never substitute `_PREV`. */
export function readEdgeSenderSecret(
  site: "student" | "admin", binding: (name: string) => unknown,
): string | undefined {
  const name = site === "student" ? "A01_RELAY_EDGE_SECRET_STUDENT" : "A01_RELAY_EDGE_SECRET_ADMIN";
  const value = binding(name);
  return isUsableEdgeSecret(value) ? value : undefined;
}
