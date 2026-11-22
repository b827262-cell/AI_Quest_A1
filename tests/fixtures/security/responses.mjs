// Security test fixtures - synthetic error response stand-ins.
// All messages and codes are obviously fake. No real error details.

export const ERROR_RESPONSES = {
  auth: {
    missing_token: { status: 401, body: { error: "missing_authentication", code: "auth_missing_token", message: "No authentication token provided" } },
    invalid_token: { status: 401, body: { error: "invalid_authentication", code: "auth_invalid_token", message: "Token is malformed or unreadable" } },
    expired_token: { status: 401, body: { error: "invalid_authentication", code: "auth_token_expired", message: "Token has expired" } },
    revoked_token: { status: 401, body: { error: "invalid_authentication", code: "auth_token_revoked", message: "Token has been revoked" } },
    wrong_realm: { status: 401, body: { error: "invalid_authentication", code: "auth_wrong_realm", message: "Token realm does not match" } }
  },
  authz: {
    insufficient_role: { status: 403, body: { error: "insufficient_permission", code: "authz_insufficient_role", message: "Role does not permit this action" } },
    wrong_course: { status: 403, body: { error: "insufficient_permission", code: "authz_wrong_course", message: "Not enrolled in this course" } },
    cross_class: { status: 403, body: { error: "insufficient_permission", code: "authz_cross_class", message: "Not a member of this class" } },
    self_only: { status: 403, body: { error: "insufficient_permission", code: "authz_self_only", message: "Can only access own records" } }
  },
  business: {
    not_found: { status: 404, body: { error: "not_found", code: "business_not_found", message: "Requested resource does not exist" } },
    duplicate: { status: 409, body: { error: "conflict", code: "business_duplicate", message: "Resource already exists" } },
    validation: { status: 400, body: { error: "invalid_request", code: "business_validation", message: "Request content is malformed" } },
    quota_exceeded: { status: 429, body: { error: "quota_exceeded", code: "business_quota", message: "Usage quota exceeded" } }
  },
  infra: {
    unavailable: { status: 503, body: { error: "service_unavailable", code: "infra_unavailable", message: "Service temporarily unavailable" } },
    timeout: { status: 504, body: { error: "gateway_timeout", code: "infra_timeout", message: "Upstream request timed out" } },
    internal: { status: 500, body: { error: "internal_error", code: "infra_internal", message: "Unexpected server error" } }
  }
};

export function errorFor(category, kind) {
  return ERROR_RESPONSES[category]?.[kind] ?? null;
}

export function isSafeError(body) {
  if (!body || typeof body !== "object") return false;
  const json = JSON.stringify(body);
  const secretPatterns = [/sk-[a-zA-Z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /ghp_[a-zA-Z0-9]{36}/, /-----BEGIN/];
  return !secretPatterns.some((p) => p.test(json));
}
