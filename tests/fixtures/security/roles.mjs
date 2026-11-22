// Security test fixtures - synthetic data only.
// All values use @example.invalid domains and obviously fake tokens.
// No real secrets, passwords, keys, or personal data are present.

export const ROLES = [
  { role: "admin", label: "Administrator", domain: "admin@example.invalid" },
  { role: "teacher", label: "Teacher", domain: "teacher@example.invalid" },
  { role: "ta", label: "Teaching Assistant", domain: "ta@example.invalid" },
  { role: "student", label: "Student", domain: "student@example.invalid" },
  { role: "unauth", label: "Unauthenticated", domain: null }
];

export const ROLE_BY_NAME = Object.fromEntries(ROLES.map((r) => [r.role, r]));

export const ROLE_PERMISSIONS = {
  admin: ["course:read", "course:write", "user:read", "user:write", "upload:read", "upload:write", "system:read"],
  teacher: ["course:read", "course:write", "user:read", "upload:read", "upload:write"],
  ta: ["course:read", "user:read", "upload:read"],
  student: ["course:read", "upload:read"],
  unauth: []
};

export function roleFor(domain) {
  return ROLES.find((r) => r.domain === domain) ?? ROLES.find((r) => r.role === "unauth");
}

export function can(role, permission) {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}
