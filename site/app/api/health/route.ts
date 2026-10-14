import { readSiteDeclaration, type SiteDeclaration } from "../backend-client";
import { readInjectedIdentity, resolveBuildIdentity } from "../../runtime-diagnostics";

type RuntimeEnv = Record<string, unknown> | undefined;

function runtimeBinding(name: string): unknown {
  const g = globalThis as unknown as {
    [key: string]: unknown;
    __env__?: RuntimeEnv;
    env?: RuntimeEnv;
  };
  return g?.[name] ?? g?.__env__?.[name] ?? g?.env?.[name] ?? null;
}

// Legacy field kept for existing consumers. The topology itself is reported by
// `role`, `site`, and `primaryOrigin`.
const BACKEND_TARGET: Record<SiteDeclaration["role"], string> = {
  standalone: "disabled-or-staging-only",
  primary: "local",
  secondary: "primary-proxy",
  misconfigured: "disabled",
};

export async function GET() {
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
  return Response.json({
    status: "ok",
    role: declared.role,
    site: declared.site,
    primaryOrigin: declared.primaryOrigin,
    gitSha: identity.gitSha,
    edge: "cloudflare-worker",
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
