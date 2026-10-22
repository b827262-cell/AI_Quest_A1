import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";

/** Local tests and smoke only. No private key or JWKS endpoint is deployed. */
export function createStudentAccessFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const teamDomain = "student-test";
  const aud = "student-test-aud";
  return {
    kid,
    jwks: { keys: [jwk] },
    teamDomain,
    aud,
    assertion(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid, ...headerOverrides })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        iss: `https://${teamDomain}.cloudflareaccess.com`, aud, iat: now, nbf: now, exp: now + 3600,
        email: "student@example.test", ...overrides
      })).toString("base64url");
      return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
    }
  };
}

export async function startFakeAccessCerts(fixture = createStudentAccessFixture()) {
  let fail = false;
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.statusCode = fail ? 503 : 200;
    res.end(fail ? JSON.stringify({ error: "unavailable" }) : JSON.stringify(fixture.jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake certs unavailable");
  return {
    ...fixture,
    certsUrl: `http://127.0.0.1:${address.port}/certs`,
    setFailure(value: boolean) { fail = value; },
    requestCount() { return requests; },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); }
  };
}
