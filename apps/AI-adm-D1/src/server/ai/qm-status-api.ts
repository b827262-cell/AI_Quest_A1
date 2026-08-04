import type { Express, Request, Response } from "express";
import { makeQmNotCheckedStatus, qmStatusResponseSchema } from "@ai-smartbook/contracts";
import { getCachedQmStatus, runValidate, runSmoke } from "./qm-runner";

export function registerQmStatusRoutes(app: Express): void {
  app.get("/api/admin/qm/status", (_req: Request, res: Response) => {
    const status = getCachedQmStatus() ?? makeQmNotCheckedStatus();
    return res.json(qmStatusResponseSchema.parse(status));
  });

  app.post("/api/admin/qm/validate", async (_req: Request, res: Response) => {
    try {
      const status = await runValidate();
      return res.json(status);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("operation_already_running")) {
        return res.status(409).json({
          error: "Another QM operation is already in progress",
          code: "QM_OPERATION_IN_PROGRESS"
        });
      }
      return res.status(500).json({ error: "QM validation failed", code: "QM_VALIDATION_FAILED" });
    }
  });

  app.post("/api/admin/qm/smoke", async (_req: Request, res: Response) => {
    try {
      const status = await runSmoke();
      return res.json(status);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("operation_already_running")) {
        return res.status(409).json({
          error: "Another QM operation is already in progress",
          code: "QM_OPERATION_IN_PROGRESS"
        });
      }
      return res.status(500).json({ error: "QM smoke test failed", code: "QM_SMOKE_FAILED" });
    }
  });
}
