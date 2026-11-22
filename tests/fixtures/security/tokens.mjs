// Security test fixtures - synthetic token stand-ins.
// All tokens are obviously fake: 40 hex chars followed by ".example.invalid".
// No real JWTs, signing keys, or secrets are present.

const FAKE_PREFIX = "0000000000000000000000000000000000000000";

export const TOKENS = {
  valid: `${FAKE_PREFIX}.valid.example.invalid`,
  expired: `${FAKE_PREFIX}.expired.example.invalid`,
  revoked: `${FAKE_PREFIX}.revoked.example.invalid`,
  malformed: "not-a-token.example.invalid",
  empty: "",
  wrongRealm: `${FAKE_PREFIX}.other-realm.example.invalid`,
  tooShort: "short.example.invalid",
  withSpaces: ` ${FAKE_PREFIX}.valid.example.invalid `
};

export const TOKEN_METADATA = {
  [TOKENS.valid]: { role: "admin", sub: "admin-001@example.invalid", exp: 9999999999, realm: "example.invalid" },
  [TOKENS.expired]: { role: "student", sub: "student-001@example.invalid", exp: 1, realm: "example.invalid" },
  [TOKENS.revoked]: { role: "teacher", sub: "teacher-001@example.invalid", exp: 9999999999, realm: "example.invalid", revokedAt: 1000000000 },
  [TOKENS.malformed]: null,
  [TOKENS.empty]: null,
  [TOKENS.wrongRealm]: { role: "student", sub: "student-002@other.example.invalid", exp: 9999999999, realm: "other.example.invalid" },
  [TOKENS.tooShort]: null,
  [TOKENS.withSpaces]: { role: "admin", sub: "admin-001@example.invalid", exp: 9999999999, realm: "example.invalid" }
};

export function tokenFor(kind) {
  return TOKENS[kind] ?? null;
}

export function isFakeToken(token) {
  return typeof token === "string" && token.includes(".example.invalid");
}
