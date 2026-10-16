/**
 * A-01 relay-protected route × verb matrix for synthetic traffic.
 *
 * Derived from the runbook's route inventory (docs/ops/relay-rollout.md §4.3,
 * baseline `d4d5c026`). Every relay-protected non-GET path/verb must be covered
 * at least `>=30` times, and GET coverage is included per the Owner 18:00
 * decision. `pathTemplate` uses `[id]`; the CLI substitutes a concrete test id
 * taken from the environment so the template never records a real data id.
 *
 * Keep this list in sync with the runbook when routes change.
 */

export const SYNTHETIC_TARGETS = [
  // --- GET coverage (Owner 18:00 decision: GET included) ---
  { site: "student", method: "GET", pathTemplate: "/api/student/me", pathClass: "student", verbClass: "get" },
  { site: "student", method: "GET", pathTemplate: "/api/student/progress", pathClass: "student", verbClass: "get" },
  { site: "admin", method: "GET", pathTemplate: "/api/admin/auth/me", pathClass: "admin", verbClass: "get" },
  { site: "admin", method: "GET", pathTemplate: "/api/admin/overview", pathClass: "admin", verbClass: "get" },
  { site: "admin", method: "GET", pathTemplate: "/api/admin/books", pathClass: "admin", verbClass: "get" },
  { site: "admin", method: "GET", pathTemplate: "/api/admin/books/[id]", pathClass: "admin", verbClass: "get" },

  // --- Non-GET coverage (each path/verb >= 30) ---
  { site: "student", method: "PUT", pathTemplate: "/api/student/progress", pathClass: "student", verbClass: "non-get" },
  { site: "admin", method: "POST", pathTemplate: "/api/admin/books", pathClass: "admin", verbClass: "non-get" },
  { site: "admin", method: "DELETE", pathTemplate: "/api/admin/books", pathClass: "admin", verbClass: "non-get" },
  { site: "admin", method: "POST", pathTemplate: "/api/admin/books/upload", pathClass: "admin", verbClass: "non-get" },
  { site: "admin", method: "DELETE", pathTemplate: "/api/admin/books/[id]", pathClass: "admin", verbClass: "non-get" },
];

/** Non-GET targets only — the set the runbook requires to reach the >=30 floor. */
export function nonGetTargets(targets = SYNTHETIC_TARGETS) {
  return targets.filter((target) => target.verbClass === "non-get");
}

/** Substitute `[id]` placeholders with a concrete, env-provided test id. */
export function resolvePath(target, ids = {}) {
  return target.pathTemplate.replace(/\[id\]/g, () => {
    const id = ids.bookId;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`no test id configured for template ${target.pathTemplate}`);
    }
    return encodeURIComponent(id.trim());
  });
}

/** Templates in the matrix that require a runtime id (for preflight checks). */
export function templatesRequiringId(targets = SYNTHETIC_TARGETS) {
  return targets.filter((target) => target.pathTemplate.includes("[id]")).map((target) => target.pathTemplate);
}
