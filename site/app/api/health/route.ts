import { isBackendSite } from "../backend-client";

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
    time: new Date().toISOString(),
  });
}
