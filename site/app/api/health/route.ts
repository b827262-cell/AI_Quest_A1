import { isBackendSite } from "../backend-client";
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

export async function GET(request: Request) {
  const isBackend = isBackendSite(request);
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
    edge: "cloudflare-worker",
    // Binding state is derived from the live worker environment, not hardcoded,
    // so staging predeploy reports unbound and a real deployment reports bound.
    d1: d1Bound ? "bound" : "unbound",
    r2: r2Bound ? "bound" : "unbound",
    storage: r2Bound ? "r2" : "none",
    phase: 2,
    role: isBackend ? "backend" : "standalone",
    backendTarget: "disabled-or-staging-only",
    version: identity.version,
    buildId: identity.buildId,
    gitSha: identity.gitSha,
    identitySource: identity.source,
    time: new Date().toISOString(),
  });
}
