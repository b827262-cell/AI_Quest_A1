import type { Express, Request, Response } from "express";
import type { StudentDataSource, StudentRuntimeMode } from "@ai-smartbook/student-runtime";

/** Readiness probe: resolves when the backing data source answers a
 * lightweight read-only query, rejects otherwise. */
export type HealthReadyCheck = () => void | Promise<void>;

/** A readiness probe must answer quickly; anything slower counts as down. */
export const DEFAULT_READY_TIMEOUT_MS = 2000;

export interface HealthRoutesOptions {
  /** Maximum time the readiness probe may take before answering 503. */
  timeoutMs?: number;
}

/** Race a readiness probe against a hard deadline. The probe may keep running
 * in the background after the deadline (fetch is aborted by its own signal),
 * but the HTTP response never waits for it. */
function runWithTimeout(check: HealthReadyCheck, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("readiness probe timed out")), timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(check)
      .then(
        () => resolve(),
        (err: unknown) => reject(err)
      )
      .finally(() => clearTimeout(timer));
  });
}

export interface ReadyCheckSources {
  mode: StudentRuntimeMode;
  /** Admin API base URL; only used in remote-api mode. */
  remoteApiBaseUrl?: string;
  /** Resolved lazily so a data source that failed to open can still report 503. */
  getDataSource: () => StudentDataSource | null;
  timeoutMs?: number;
}

function remoteReadyUrl(baseUrl: string | undefined): URL {
  const base = (baseUrl ?? "").trim();
  if (!base) throw new Error("remote api base url is not configured");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("remote api base url is not a valid absolute url");
  }
  // The admin readiness probe is a public root endpoint.
  return new URL("/health/ready", parsed);
}

/**
 * Build the readiness probe for the configured runtime mode.
 *
 * `remote-api` must not touch the local data source: that data source is a
 * proxy that fetches the admin `/api/student/books` route without a student
 * session, so it would always fail. Instead we ask the admin API for its own
 * public readiness probe and require a 2xx answer.
 *
 * `static` and `sqlite-api` keep the cheap read-only local check.
 */
export function createReadyCheck(sources: ReadyCheckSources): HealthReadyCheck {
  const { mode, remoteApiBaseUrl, getDataSource } = sources;
  const timeoutMs = sources.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  if (mode === "remote-api") {
    return async () => {
      const target = remoteReadyUrl(remoteApiBaseUrl);
      const response = await fetch(target, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
      // Release the socket without buffering the peer's body.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`remote readiness probe answered ${response.status}`);
    };
  }

  return async () => {
    const dataSource = getDataSource();
    if (!dataSource) throw new Error("student data source unavailable");
    await dataSource.listBooks();
  };
}

/**
 * Public liveness/readiness probes for the standalone student API.
 *
 * They must be registered before the auth boundary and before the SPA
 * fallback, otherwise an unauthenticated probe is rejected or answered with
 * index.html. Neither endpoint returns application data: only a fixed status
 * literal.
 */
export function registerHealthRoutes(
  app: Express,
  readyCheck: HealthReadyCheck,
  options: HealthRoutesOptions = {}
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  app.get("/health/live", (_req: Request, res: Response) => {
    res.status(200).json({ status: "live" });
  });

  app.get("/health/ready", async (_req: Request, res: Response) => {
    try {
      await runWithTimeout(readyCheck, timeoutMs);
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });
}
