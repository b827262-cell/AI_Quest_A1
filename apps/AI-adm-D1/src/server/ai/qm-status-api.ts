import type { Express, Request, Response } from "express";
import { makeQmNotCheckedStatus, qmRuntimeConfigSchema, qmStatusResponseSchema } from "@ai-smartbook/contracts";
import { getCachedQmStatus, runValidate, runSmoke } from "./qm-runner";
import {
  createQmRuntimeConfigService,
  httpStatusForQmRuntimeBlock,
  runQmRuntimeConfigTest,
  type QmRuntimeConfigProbe
} from "./qm-runtime-config";
import { redactSecrets } from "./qm-runner";

/**
 * Injectable boundary for the runtime-config service + test probe. The server
 * wires production implementations; HTTP tests inject stubs to assert the safe
 * shape deterministically. Keeping this injectable means the route bodies here
 * are exercised by the same auth/origin boundary as the QM status routes.
 */
export type QmRuntimeConfigDeps = {
  /** Build the service from a settings repo + live reader. */
  service: ReturnType<typeof createQmRuntimeConfigService>;
  /** Build the bounded test probe for an already-resolved selection. */
  buildProbe: (credentialId: string, signalCarrier: { setUpstreamRequestSent: () => void }) => QmRuntimeConfigProbe;
};

export function registerQmStatusRoutes(app: Express, runtimeConfigDeps?: QmRuntimeConfigDeps): void {
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

  if (runtimeConfigDeps) {
    registerQmRuntimeConfigRoutes(app, runtimeConfigDeps);
  }
}

/**
 * Register the QM runtime-config routes. All three run the full fail-closed
 * {@link resolveQmRuntimeConfig} check on every call (not only on save), so a
 * provider/credential disabled after the config was saved can never serve a
 * stale selection. Every response is redacted and never carries a key.
 */
export function registerQmRuntimeConfigRoutes(app: Express, deps: QmRuntimeConfigDeps): void {
  app.get("/api/admin/qm/runtime-config", (_req: Request, res: Response) => {
    // GET still resolves so a stale/disabled selection is surfaced as blocked,
    // not silently served. The public view never includes a plaintext key.
    const view = deps.service.getPublicView();
    const resolution = deps.service.resolve();
    const payload = redactSecrets(JSON.stringify({ view, resolution }));
    return res.json(JSON.parse(payload));
  });

  app.put("/api/admin/qm/runtime-config", (req: Request, res: Response) => {
    const parsed = qmRuntimeConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid QM runtime config", code: "QM_RUNTIME_CONFIG_INVALID" });
    }
    // Validate-then-save: persist the references, then re-resolve to confirm
    // the just-saved selection is currently usable. If it is blocked, the
    // config is still stored (so the admin can see/fix it) but we return the
    // exact safe error code rather than implying success.
    const saved = deps.service.save(parsed.data);
    const resolution = deps.service.resolve();
    if (!resolution.ok) {
      return res.status(httpStatusForQmRuntimeBlock(resolution.reason)).json({
        error: redactSecrets(`QM runtime config blocked: ${resolution.reason}`),
        code: resolution.reason,
        config: saved
      });
    }
    return res.status(200).json({ config: saved, resolution });
  });

  app.post("/api/admin/qm/runtime-config/test", async (_req: Request, res: Response) => {
    // Resolve first (fail-closed). Never run a probe against a blocked config.
    const resolution = deps.service.resolve();
    if (!resolution.ok) {
      return res.status(httpStatusForQmRuntimeBlock(resolution.reason)).json({
        error: redactSecrets(`QM runtime config blocked: ${resolution.reason}`),
        code: resolution.reason
      });
    }
    const model = resolution.config.model;
    let upstreamRequestSent = false;
    const probe = deps.buildProbe(resolution.config.credentialId, {
      setUpstreamRequestSent: () => { upstreamRequestSent = true; }
    });
    const result = await runQmRuntimeConfigTest(model, async (signal) => {
      const out = await probe(signal);
      // upstreamRequestSent is tracked both via the carrier (for classification)
      // and returned by the probe (for the safe result).
      return { upstreamRequestSent: out.upstreamRequestSent || upstreamRequestSent };
    });
    const payload = redactSecrets(JSON.stringify(result));
    const status = result.status === "success" ? 200 : result.reason === "provider_timeout" ? 504 : 502;
    return res.status(status).json(JSON.parse(payload));
  });
}
