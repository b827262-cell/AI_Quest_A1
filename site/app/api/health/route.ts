import { isBackendSite } from "../backend-client";

export async function GET(request: Request) {
  const isBackend = isBackendSite(request);
  return Response.json({
    status: "ok",
    edge: "cloudflare-worker",
    d1: "bound",
    r2: "bound",
    storage: "r2",
    phase: 2,
    role: isBackend ? "shared-backend" : "frontend-proxy",
    backendTarget: "https://ai-quest-a1-backend.b827262.chatgpt.site",
    sharedD1Project: "appgprj_6aa80235182c8191a876361138ecbc36",
    sharedR2Project: "appgprj_6aa80235182c8191a876361138ecbc36",
    sharedR2Bucket: "BOOKS_BUCKET",
    time: new Date().toISOString(),
  });
}
