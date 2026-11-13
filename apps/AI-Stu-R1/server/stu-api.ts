import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import {
  assertStudentAuthConfig,
  createStudentAuthRuntime,
  resolveStudentAuthConfig
} from "@ai-smartbook/auth/server";
import {
  loadStudentRuntimeConfig,
  createDataSource,
  type StudentDataSource
} from "@ai-smartbook/student-runtime";
import { DEFAULT_APPEARANCE } from "@ai-smartbook/schema";
import {
  createStudentAuthRouter,
  createStudentSessionMiddleware,
  createStudentLearningHistoryRouter,
  oversizeJsonBodyHandler,
  invalidJsonBodyHandler,
  MAX_LEARNING_HISTORY_BODY_BYTES
} from "@ai-smartbook/auth/express";
import { createStudentRagRouter, resolveStudentRagEnv } from "./student-rag";
import { createReadyCheck, registerHealthRoutes } from "./health-routes";
import { logServerError, registerStudentBookRoutes } from "./student-book-routes";

const config = loadStudentRuntimeConfig();
const studentAuthConfig = resolveStudentAuthConfig(process.env);
assertStudentAuthConfig(studentAuthConfig);
const studentAuthDbPath = process.env.STUDENT_AUTH_DB_PATH || process.env.SQLITE_PATH || resolve(process.cwd(), "data", "ai-smartbook-r1.db");
const studentAuthRuntime = createStudentAuthRuntime(studentAuthDbPath, studentAuthConfig);

// Build the data source defensively: a missing/unopenable SQLite file (e.g.
// the student.db has not been synced yet) must not crash the server. We keep
// the process alive and answer data endpoints with an explicit 503 instead.
// The failure detail stays in the server log (stable class/code only) and is
// never echoed to a client.
let dataSource: StudentDataSource | null = null;
try {
  dataSource = createDataSource(config);
} catch (err) {
  logServerError("stu-api", "data source unavailable", err);
}

if (process.env.TRUST_PROXY !== undefined) {
  console.warn("TRUST_PROXY is no longer used for client IP resolution; only loopback Cloudflare headers are trusted.");
}
const app = express();
app.use("/api/student/learning-history", express.json({ limit: MAX_LEARNING_HISTORY_BODY_BYTES }));
app.use(express.json());

// Liveness/readiness probes are public and registered ahead of both the auth
// boundary and the SPA fallback, so a probe never needs a session and never
// receives index.html. In remote-api mode readiness asks the admin API's own
// public probe: the local data source proxies an authenticated admin route and
// would always answer 503 here. The result is never returned to the caller.
registerHealthRoutes(app, createReadyCheck({
  mode: config.mode,
  remoteApiBaseUrl: config.remoteApiBaseUrl,
  getDataSource: () => dataSource
}));

// Appearance is authored in the admin system; the standalone student server
// serves the schema defaults so the SPA never 404s on boot.
app.get("/api/appearance-settings", (_req, res) => {
  res.json({ settings: DEFAULT_APPEARANCE });
});

// Google OAuth and session restore are public auth boundaries. All learning
// endpoints below them require the same server-side Student session.
app.use("/api/student/auth", createStudentAuthRouter(studentAuthRuntime.auth, studentAuthConfig));
app.use("/api/student", createStudentSessionMiddleware(studentAuthRuntime.auth, studentAuthConfig));
app.use("/api/student", createStudentLearningHistoryRouter(studentAuthRuntime.learningHistory, studentAuthConfig));

// Scoped RAG question endpoint: session + completed profile are already
// enforced by the middleware above; the route derives studentId/bookId from
// the session and route parameter, never from the request body.
app.use("/api/student", createStudentRagRouter({
  getDataSource: () => dataSource,
  env: resolveStudentRagEnv()
}));

// ---- Student API (read-only) ---------------------------------------------
registerStudentBookRoutes(app, {
  getDataSource: () => dataSource,
  mode: config.mode,
  chatMode: config.chatMode,
  uploadDir: config.uploadDir
});

// ---- Static frontend (production) ----------------------------------------
const publicDir = resolve(config.publicDir);
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(resolve(publicDir, "index.html"));
  });
}

// Last error boundary: oversize JSON bodies answer a stable JSON 413 instead of
// Express' HTML page (which prints a stack trace in development). Only the
// learning-history endpoints use BATCH_TOO_LARGE; every other route answers the
// generic PAYLOAD_TOO_LARGE. A body that is not valid JSON answers JSON 400, and
// non-parser errors keep the default behaviour.
app.use(oversizeJsonBodyHandler());
app.use(invalidJsonBodyHandler());

app.listen(config.apiPort, () => {
  console.log(
    `AI-Stu-R1 student API listening on ${config.apiPort} (mode=${config.mode}, chat=${config.chatMode})`
  );
});

export { app };
