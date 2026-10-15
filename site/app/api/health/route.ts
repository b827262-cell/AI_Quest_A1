import { readSiteDeclaration, type SiteDeclaration } from "../backend-client";
import { isAdminAllowlistConfigured } from "../auth-helper";
import { isProductionEnvironment } from "../../../db";
import { readRelayMode, relayKeyCount, verifyIncomingRelay } from "../../../lib/relay-verification";
import { readInjectedIdentity, resolveBuildIdentity } from "../../runtime-diagnostics";
import { countValidEdgeSecrets, readEdgeGateMode, type EdgeSecrets } from "../../../lib/relay-edge-gate";

type RuntimeEnv = Record<string, unknown> | undefined;

function runtimeBinding(name: string): unknown {
  const g = globalThis as unknown as {
    [key: string]: unknown;
    __env__?: RuntimeEnv;
    env?: RuntimeEnv;
  };
  return g?.[name] ?? g?.__env__?.[name] ?? g?.env?.[name] ?? null;
}

// The edge gate reads these from the same live worker environment. Only counts
// are reported below; values, lengths, prefixes and hashes are never exposed.
function edgeGateBindings(): EdgeSecrets {
  return {
    A01_RELAY_EDGE_SECRET_STUDENT: runtimeBinding("A01_RELAY_EDGE_SECRET_STUDENT") as string | undefined,
    A01_RELAY_EDGE_SECRET_STUDENT_PREV: runtimeBinding("A01_RELAY_EDGE_SECRET_STUDENT_PREV") as string | undefined,
    A01_RELAY_EDGE_SECRET_ADMIN: runtimeBinding("A01_RELAY_EDGE_SECRET_ADMIN") as string | undefined,
    A01_RELAY_EDGE_SECRET_ADMIN_PREV: runtimeBinding("A01_RELAY_EDGE_SECRET_ADMIN_PREV") as string | undefined,
    A01_RELAY_EDGE_MODE: runtimeBinding("A01_RELAY_EDGE_MODE") as string | undefined,
  };
}

// Legacy field kept for existing consumers. The topology itself is reported by
// `role`, `site`, and `primaryOrigin`.
const BACKEND_TARGET: Record<SiteDeclaration["role"], string> = {
  standalone: "disabled-or-staging-only",
  primary: "local",
  secondary: "primary-proxy",
  misconfigured: "disabled",
};

export async function GET(request: Request) {
  const declared = readSiteDeclaration();
  const d1Bound = Boolean(runtimeBinding("DB"));
  const r2Bound = Boolean(runtimeBinding("BOOKS_BUCKET"));
  // Identity is resolved through the same helper the browser uses, so a deployed
  // worker can always be matched against the frontend it is serving.
  const identity = resolveBuildIdentity({
    env: {
      VERSION: runtimeBinding("VERSION"),
      BUILD_ID: runtimeBinding("BUILD_ID"),
      GIT_SHA: runtimeBinding("GIT_SHA"),
      COMMIT_SHA: runtimeBinding("COMMIT_SHA"),
    },
    injected: readInjectedIdentity(),
  });
  // Whether an administrator allowlist exists is observable without ever
  // exposing an address. When it is unset, nobody can be an administrator.
  // The log line fires in production, where a missing allowlist is a real
  // lockout risk; the health field is always present.
  const adminAllowlist = isAdminAllowlistConfigured();
  if (!adminAllowlist && isProductionEnvironment()) {
    console.warn(
      "[auth] ADMIN_EMAILS allowlist is not configured; no user can be an administrator",
    );
  }
  const relaySeen = (await verifyIncomingRelay(request)).status;
  // Read-only observability for the primary edge gate: operators can confirm
  // the mode and per-site secret counts from health after switching to require.
  // Health stays exempt from the gate and still does not write relay.verify.
  const edgeGate = edgeGateBindings();
  const edgeSecretCounts = countValidEdgeSecrets(edgeGate);
  return Response.json({
    status: "ok",
    relayMode: readRelayMode(),
    relayKeys: relayKeyCount(),
    relaySeen,
    edgeMode: readEdgeGateMode(edgeGate.A01_RELAY_EDGE_MODE),
    edgeSecrets: { student: edgeSecretCounts.student, admin: edgeSecretCounts.admin },
    edgeSecretsDistinct: edgeSecretCounts.distinct,
    role: declared.role,
    site: declared.site,
    primaryOrigin: declared.primaryOrigin,
    gitSha: identity.gitSha,
    edge: "cloudflare-worker",
    adminAllowlist: adminAllowlist ? "configured" : "unset",
    // Binding state is derived from the live worker environment, not hardcoded,
    // so staging predeploy reports unbound and a real deployment reports bound.
    d1: d1Bound ? "bound" : "unbound",
    r2: r2Bound ? "bound" : "unbound",
    storage: r2Bound ? "r2" : "none",
    phase: 2,
    backendTarget: BACKEND_TARGET[declared.role],
    version: identity.version,
    buildId: identity.buildId,
    identitySource: identity.source,
    time: new Date().toISOString(),
  });
}
