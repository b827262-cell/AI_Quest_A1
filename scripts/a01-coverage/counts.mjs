/**
 * Aggregate counts for the A-01 coverage aggregator.
 *
 * Natural and synthetic samples are always reported separately. Per the Owner
 * decisions: synthetic samples only supplement the per-path >= 30 requirement;
 * they are never counted toward the Student 300 / Admin 100 site totals.
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  studentValid: 300,
  adminValid: 100,
  perPathVerb: 30,
});

/**
 * Applicable non-GET path x verb rows from docs/ops/relay-rollout.md §4.4.
 * These are the rows that must each reach the per-path target.
 */
export const DEFAULT_APPLICABLE_NON_GET = Object.freeze([
  { site: "student", route: "/api/student/progress", method: "PUT" },
  { site: "admin", route: "/api/admin/books", method: "POST" },
  { site: "admin", route: "/api/admin/books", method: "DELETE" },
  { site: "admin", route: "/api/admin/books/upload", method: "POST" },
  { site: "admin", route: "/api/admin/books/[id]", method: "DELETE" },
]);

function emptyBucket() {
  return { natural: 0, synthetic: 0, total: 0 };
}

function bump(bucket, synthetic) {
  if (synthetic) bucket.synthetic += 1;
  else bucket.natural += 1;
  bucket.total += 1;
}

/**
 * @param {object[]} events validated relay.verify events
 * @param {object} [options]
 * @returns {object} aggregate report
 */
export function computeCounts(events, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const applicable = options.applicable ?? DEFAULT_APPLICABLE_NON_GET;

  const validBySite = { student: emptyBucket(), admin: emptyBucket() };
  const pathClassMethod = {};
  const routeMethod = {};
  let routePresent = false;
  let invalid = 0;
  let noneWithIdentity = 0;

  for (const event of events) {
    if (event.result === "valid") {
      const bucket = validBySite[event.site];
      if (bucket) bump(bucket, event.synthetic);
    }
    const pcKey = `${event.pathClass}/${event.method}`;
    (pathClassMethod[pcKey] ??= emptyBucket());
    bump(pathClassMethod[pcKey], event.synthetic);

    if (typeof event.route === "string" && event.route !== "") {
      routePresent = true;
      const rKey = `${event.method} ${event.route}`;
      (routeMethod[rKey] ??= emptyBucket());
      bump(routeMethod[rKey], event.synthetic);
    }

    if (event.result === "invalid") invalid += 1;
    if (event.result === "none" && event.identityPresent === true) noneWithIdentity += 1;
  }

  const perPathVerb = applicable.map((row) => {
    const bucket = routeMethod[`${row.method} ${row.route}`] ?? emptyBucket();
    return {
      site: row.site,
      route: row.route,
      method: row.method,
      required: thresholds.perPathVerb,
      natural: bucket.natural,
      synthetic: bucket.synthetic,
      total: bucket.total,
      met: bucket.total >= thresholds.perPathVerb,
    };
  });

  return {
    events_total: events.length,
    valid: {
      student: { ...validBySite.student },
      admin: { ...validBySite.admin },
    },
    path_class_method: pathClassMethod,
    route_method: routeMethod,
    route_available: routePresent,
    thresholds: {
      student_valid: {
        required: thresholds.studentValid,
        natural: validBySite.student.natural,
        met: validBySite.student.natural >= thresholds.studentValid,
      },
      admin_valid: {
        required: thresholds.adminValid,
        natural: validBySite.admin.natural,
        met: validBySite.admin.natural >= thresholds.adminValid,
      },
      per_path_verb: {
        required: thresholds.perPathVerb,
        status: routePresent ? "evaluated" : "undeterminable",
        reason: routePresent
          ? null
          : "relay.verify alone cannot distinguish sub-routes; supply a `route` field (route template) from the invocation cross-reference",
        rows: perPathVerb,
      },
    },
    zero_tolerance: {
      invalid,
      none_with_identity: noneWithIdentity,
      ok: invalid === 0 && noneWithIdentity === 0,
    },
  };
}
