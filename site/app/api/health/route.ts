import { getStagingBackendOrigin } from "../backend-client";

export async function GET() {
  const backendTarget = getStagingBackendOrigin();
  return Response.json({
    status: backendTarget ? "staging" : "isolated",
    edge: "cloudflare-worker",
    d1: "disabled",
    r2: "disabled",
    storage: "disabled",
    role: "staging-isolated",
    backendTarget,
    sharedD1Project: null,
    sharedR2Project: null,
    sharedR2Bucket: null,
    isolation: backendTarget ? "staging-only" : "disabled",
    time: new Date().toISOString(),
  });
}
