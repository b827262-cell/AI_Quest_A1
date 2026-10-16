/**
 * Injection plan for the A-01 synthetic traffic injector.
 *
 * The applicable routes/methods come from `docs/ops/relay-rollout.md` §4.4
 * (the per-path read/write coverage table). GET paths are included per the
 * Owner 18:00 decision; every applicable non-GET path x verb is included too.
 *
 * `[id]` templates are resolved from configured concrete ids. Payloads are
 * deliberately synthetic and carry no real user data.
 */

/** Route/method pairs that must reach >= target valid verifications per site. */
export const PLANS = Object.freeze({
  student: Object.freeze([
    { route: "/api/student/me", method: "GET", kind: "read" },
    { route: "/api/student/progress", method: "GET", kind: "read" },
    { route: "/api/student/progress", method: "PUT", kind: "write", body: { progress: 0 } },
  ]),
  admin: Object.freeze([
    { route: "/api/admin/auth/me", method: "GET", kind: "read" },
    { route: "/api/admin/overview", method: "GET", kind: "read" },
    { route: "/api/admin/books", method: "GET", kind: "read" },
    { route: "/api/admin/books/[id]", method: "GET", kind: "read" },
    { route: "/api/admin/books", method: "POST", kind: "write", body: { title: "synthetic-book", subject: "synthetic" } },
    { route: "/api/admin/books", method: "DELETE", kind: "write", query: "?id=SYNTHETIC_ID" },
    { route: "/api/admin/books/upload", method: "POST", kind: "write", body: { title: "synthetic-upload", subject: "synthetic" } },
    { route: "/api/admin/books/[id]", method: "DELETE", kind: "write" },
  ]),
});

/**
 * Substitute `[id]` in a route template with a concrete id.
 * @param {string} route
 * @param {string|undefined} id
 */
export function resolveRoute(route, id) {
  if (!route.includes("[id]")) return route;
  const resolved = id ?? "synthetic-id";
  return route.replace(/\[id\]/g, encodeURIComponent(resolved));
}

/**
 * Build a flat list of concrete request descriptors for a site.
 *
 * @param {"student"|"admin"} site
 * @param {object} [options]
 * @param {number} [options.targetPerPath=30] desired valid count per path x method
 * @param {string} [options.id] concrete id for `[id]` templates
 * @returns {Array<{site:string, routeTemplate:string, route:string, method:string, kind:string, body?:unknown, query?:string, target:number}>}
 */
export function buildPlan(site, options = {}) {
  const { targetPerPath = 30, id } = options;
  if (!Number.isInteger(targetPerPath) || targetPerPath < 1) {
    throw new Error("targetPerPath must be a positive integer");
  }
  const rows = PLANS[site];
  if (!rows) throw new Error(`unknown site: ${site}`);
  return rows.map((row) => {
    const route = resolveRoute(row.route, id);
    const query = row.query ? row.query.replace(/SYNTHETIC_ID/g, encodeURIComponent(id ?? "synthetic-id")) : "";
    return {
      site,
      routeTemplate: row.route,
      route,
      method: row.method,
      kind: row.kind,
      body: row.body,
      query,
      target: targetPerPath,
    };
  });
}

/** Total number of requests the plan will attempt. */
export function planTotal(plan) {
  return plan.reduce((sum, row) => sum + row.target, 0);
}

/** Just the applicable non-GET path x verb rows (for reporting). */
export function nonGetRows(plan) {
  return plan.filter((row) => row.method !== "GET" && row.method !== "HEAD");
}
