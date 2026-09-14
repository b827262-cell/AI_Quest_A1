export async function GET() {
  return Response.json({
    status: "ok",
    edge: "cloudflare-worker",
    d1: "bound",
    phase: 2,
    time: new Date().toISOString(),
  });
}
