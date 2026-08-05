import { createAiProvider } from "@ai-smartbook/ai";
import { createRepositories, getDb, runMigrations, type DbHandle } from "@ai-smartbook/db";
import { resolve } from "node:path";
import { buildGateway } from "./ai/gateway-instance";
import { makeAnalyticsService } from "./ai/analytics-service";
import { makeEvaluationGovernanceService } from "./ai/evaluation-governance-service";
import { makeEvaluationService } from "./ai/evaluation-service";
import { makeLiveEvaluationService } from "./ai/live-evaluation-service";
import { makePilotService } from "./ai/pilot-service";
import { resolveGuestAskIpHmacSecret } from "@ai-smartbook/ai/server";
import type { AdminAppDependencies } from "./app";

export interface AdminDependencyOptions {
  env?: NodeJS.ProcessEnv;
  dbHandle?: DbHandle;
}

/**
 * Build the complete dependency graph once at the process boundary.
 * `createAdminApp` remains a pure Express composition function so tests can
 * exercise the real routes without opening a TCP listener.
 */
export function createAdminDependencies(options: AdminDependencyOptions = {}): AdminAppDependencies {
  const env = options.env ?? process.env;
  const handle = options.dbHandle ?? getDb();
  runMigrations(handle.sqlite);
  const repos = createRepositories(handle.db);
  const ai = createAiProvider();
  const { gateway: aiGateway, config: gatewayConfig } = buildGateway(repos);
  const analytics = makeAnalyticsService(repos, {
    dailyTokenLimit: gatewayConfig.dailyTokenLimit,
    dailyCostLimitUsd: gatewayConfig.dailyCostLimitUsd
  });
  const evaluationService = makeEvaluationService(repos, (action, targetId, metadata) => {
    repos.aiProviders.audit(action, "ai_evaluation_run", targetId, metadata);
  });
  const liveEvaluationService = makeLiveEvaluationService(repos, (action, targetId, metadata) => {
    repos.aiProviders.audit(action, "ai_evaluation_live", targetId, metadata);
  });
  const evaluationGovernanceService = makeEvaluationGovernanceService(repos, evaluationService, (action, targetId, metadata) => {
    repos.aiProviders.audit(action, "ai_evaluation_governance", targetId, metadata);
  });
  const pilotService = makePilotService(repos, liveEvaluationService, (action, targetId, metadata) => {
    repos.aiProviders.audit(action, "ai_multi_model_pilot", targetId, metadata);
  });

  return {
    env,
    repos,
    ai,
    aiGateway,
    gatewayConfig,
    guestAskIpHmacSecret: resolveGuestAskIpHmacSecret(),
    guestAskRetentionDays: Number(env.GUEST_ASK_RETENTION_DAYS || 7),
    analytics,
    evaluationService,
    liveEvaluationService,
    evaluationGovernanceService,
    pilotService,
    uploadRoot: resolve(env.UPLOAD_DIR || resolve("./uploads", "books")),
    appearanceUploadDir: resolve(env.UPLOAD_DIR || "./uploads", "appearance")
  };
}

export function createAdminTestDependencies(env: NodeJS.ProcessEnv, dbHandle: DbHandle): AdminAppDependencies {
  return createAdminDependencies({ env, dbHandle });
}
