import type { Express, Request, Response } from "express";

/** Readiness probe: resolves when the backing data source answers a
 * lightweight read-only query, rejects otherwise. */
export type HealthReadyCheck = () => void | Promise<void>;

/**
 * Public liveness/readiness probes for the standalone student API.
 *
 * They must be registered before the auth boundary and before the SPA
 * fallback, otherwise an unauthenticated probe is rejected or answered with
 * index.html. Neither endpoint returns application data: only a fixed status
 * literal.
 */
export function registerHealthRoutes(app: Express, readyCheck: HealthReadyCheck): void {
  app.get("/health/live", (_req: Request, res: Response) => {
    res.status(200).json({ status: "live" });
  });

  app.get("/health/ready", async (_req: Request, res: Response) => {
    try {
      await readyCheck();
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });
}
