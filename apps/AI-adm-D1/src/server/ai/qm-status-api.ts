import type { Express, Request, Response } from "express";
import { getCachedQmStatus, runValidate, runSmoke } from "./qm-runner";

export function registerQmStatusRoutes(app: Express): void {
  app.get("/api/admin/qm/status", (_req: Request, res: Response) => {
    const status = getCachedQmStatus();
    if (!status) {
      return res.json({
        overallStatus: "warning",
        checkedAt: null,
        qmCliVersion: null,
        contract: null,
        doctor: null,
        smoke: null,
        message: "QM status has not been checked yet."
      });
    }
    return res.json(status);
  });

  app.post("/api/admin/qm/validate", async (_req: Request, res: Response) => {
    try {
      const status = await runValidate();
      return res.json(status);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("operation_already_running")) {
        return res.status(409).json({ error: "Validation is already in progress" });
      }
      return res.status(500).json({ error: "Internal error during validation" });
    }
  });

  app.post("/api/admin/qm/smoke", async (_req: Request, res: Response) => {
    try {
      const status = await runSmoke();
      return res.json(status);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("operation_already_running")) {
        return res.status(409).json({ error: "Smoke test is already in progress" });
      }
      return res.status(500).json({ error: "Internal error during smoke test" });
    }
  });
}
