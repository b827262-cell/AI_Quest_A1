import type { Db } from "../client";
import { makeBookRepo } from "./book.repo";
import { makeBookFileRepo } from "./bookFile.repo";
import { makeBookContentRepo } from "./bookContent.repo";
import { makeChapterRepo } from "./chapter.repo";
import { makeChatRepo } from "./chat.repo";
import { makeAiJobRepo } from "./aiJob.repo";
import { makeQaLogRepo } from "./qaLog.repo";
import { makePdfAccessLogRepo } from "./pdfAccessLog.repo";
import { makeSettingsRepo } from "./settings.repo";
import { makeSmartBookNoteRepo } from "./smartBookNote.repo";
import { makeAiRequestLogRepo } from "./aiRequestLog.repo";
import { makeAiUsageLogRepo } from "./aiUsageLog.repo";
import { makeGuestAskAnswerRepo } from "./guestAskAnswer.repo";
import { makeAiBudgetPolicyRepo } from "./aiBudgetPolicy.repo";
import { makeAiDailyUsageRepo } from "./aiDailyUsage.repo";
import { makeAiBudgetReservationRepo } from "./aiBudgetReservation.repo";
import { makeAiProviderRepo } from "./aiProvider.repo";
import { makeAiCredentialModelQuotaRepo } from "./aiCredentialModelQuota.repo";
import { makeAiLogicalModelRepo } from "./aiLogicalModel.repo";
import { makeAiTokenPoolRepo } from "./aiTokenPool.repo";
import { makeAiModelDailyLimitRepo } from "./aiModelDailyLimit.repo";
import { makeAiTokenPoolReservationRepo } from "./aiTokenPoolReservation.repo";
import { makeAiCredentialDailyUsageRepo } from "./aiCredentialDailyUsage.repo";
import { makeAiEvaluationRunRepo } from "./aiEvaluationRun.repo";
import { makeAiEvaluationMetricRepo } from "./aiEvaluationMetric.repo";
import { makeAiEvaluationIssueRepo } from "./aiEvaluationIssue.repo";
import { makeAiEvaluationControlRepo } from "./aiEvaluationControl.repo";
import { makeAiEvaluationGovernanceRepo } from "./aiEvaluationGovernance.repo";
import { makeAiMultiModelPilotRepo } from "./aiMultiModelPilot.repo";
import { makeAdminSessionRepo } from "./adminSession.repo";

export * from "./book.repo";
export * from "./bookFile.repo";
export * from "./bookContent.repo";
export * from "./chapter.repo";
export * from "./chat.repo";
export * from "./aiJob.repo";
export * from "./qaLog.repo";
export * from "./pdfAccessLog.repo";
export * from "./settings.repo";
export * from "./smartBookNote.repo";
export * from "./aiRequestLog.repo";
export * from "./aiUsageLog.repo";
export * from "./guestAskAnswer.repo";
export * from "./aiBudgetPolicy.repo";
export * from "./aiDailyUsage.repo";
export * from "./aiBudgetReservation.repo";
export * from "./aiProvider.repo";
export * from "./aiCredentialModelQuota.repo";
export * from "./aiLogicalModel.repo";
export * from "./aiTokenPool.repo";
export * from "./aiModelDailyLimit.repo";
export * from "./aiTokenPoolReservation.repo";
export * from "./aiCredentialDailyUsage.repo";
export * from "./timezone.util";
export * from "./aiEvaluationRun.repo";
export * from "./aiEvaluationMetric.repo";
export * from "./aiEvaluationIssue.repo";
export * from "./aiEvaluationControl.repo";
export * from "./aiEvaluationGovernance.repo";
export * from "./aiMultiModelPilot.repo";
export * from "./adminSession.repo";

export interface Repositories {
  books: ReturnType<typeof makeBookRepo>;
  files: ReturnType<typeof makeBookFileRepo>;
  contents: ReturnType<typeof makeBookContentRepo>;
  chapters: ReturnType<typeof makeChapterRepo>;
  chat: ReturnType<typeof makeChatRepo>;
  aiJobs: ReturnType<typeof makeAiJobRepo>;
  qaLogs: ReturnType<typeof makeQaLogRepo>;
  pdfAccessLogs: ReturnType<typeof makePdfAccessLogRepo>;
  settings: ReturnType<typeof makeSettingsRepo>;
  notes: ReturnType<typeof makeSmartBookNoteRepo>;
  aiRequestLogs: ReturnType<typeof makeAiRequestLogRepo>;
  aiUsageLogs: ReturnType<typeof makeAiUsageLogRepo>;
  guestAskAnswers: ReturnType<typeof makeGuestAskAnswerRepo>;
  aiBudgetPolicies: ReturnType<typeof makeAiBudgetPolicyRepo>;
  aiDailyUsage: ReturnType<typeof makeAiDailyUsageRepo>;
  aiBudgetReservations: ReturnType<typeof makeAiBudgetReservationRepo>;
  aiProviders: ReturnType<typeof makeAiProviderRepo>;
  aiCredentialModelQuotas: ReturnType<typeof makeAiCredentialModelQuotaRepo>;
  aiLogicalModels: ReturnType<typeof makeAiLogicalModelRepo>;
  aiTokenPools: ReturnType<typeof makeAiTokenPoolRepo>;
  aiModelDailyLimits: ReturnType<typeof makeAiModelDailyLimitRepo>;
  aiTokenPoolReservations: ReturnType<typeof makeAiTokenPoolReservationRepo>;
  aiCredentialDailyUsage: ReturnType<typeof makeAiCredentialDailyUsageRepo>;
  aiEvaluationRuns: ReturnType<typeof makeAiEvaluationRunRepo>;
  aiEvaluationMetrics: ReturnType<typeof makeAiEvaluationMetricRepo>;
  aiEvaluationIssues: ReturnType<typeof makeAiEvaluationIssueRepo>;
  aiEvaluationControl: ReturnType<typeof makeAiEvaluationControlRepo>;
  aiEvaluationGovernance: ReturnType<typeof makeAiEvaluationGovernanceRepo>;
  aiMultiModelPilot: ReturnType<typeof makeAiMultiModelPilotRepo>;
  adminSessions: ReturnType<typeof makeAdminSessionRepo>;
}

/** Build all repositories bound to a single Db handle. */
export function createRepositories(db: Db): Repositories {
  return {
    books: makeBookRepo(db),
    files: makeBookFileRepo(db),
    contents: makeBookContentRepo(db),
    chapters: makeChapterRepo(db),
    chat: makeChatRepo(db),
    aiJobs: makeAiJobRepo(db),
    qaLogs: makeQaLogRepo(db),
    pdfAccessLogs: makePdfAccessLogRepo(db),
    settings: makeSettingsRepo(db),
    notes: makeSmartBookNoteRepo(db),
    aiRequestLogs: makeAiRequestLogRepo(db),
    aiUsageLogs: makeAiUsageLogRepo(db),
    guestAskAnswers: makeGuestAskAnswerRepo(db),
    aiBudgetPolicies: makeAiBudgetPolicyRepo(db),
    aiDailyUsage: makeAiDailyUsageRepo(db),
    aiBudgetReservations: makeAiBudgetReservationRepo(db),
    aiProviders: makeAiProviderRepo(db),
    aiCredentialModelQuotas: makeAiCredentialModelQuotaRepo(db),
    aiLogicalModels: makeAiLogicalModelRepo(db),
    aiTokenPools: makeAiTokenPoolRepo(db),
    aiModelDailyLimits: makeAiModelDailyLimitRepo(db),
    aiTokenPoolReservations: makeAiTokenPoolReservationRepo(db),
    aiCredentialDailyUsage: makeAiCredentialDailyUsageRepo(db),
    aiEvaluationRuns: makeAiEvaluationRunRepo(db),
    aiEvaluationMetrics: makeAiEvaluationMetricRepo(db),
    aiEvaluationIssues: makeAiEvaluationIssueRepo(db)
    ,aiEvaluationControl: makeAiEvaluationControlRepo(db),
    aiEvaluationGovernance: makeAiEvaluationGovernanceRepo(db),
    aiMultiModelPilot: makeAiMultiModelPilotRepo(db),
    adminSessions: makeAdminSessionRepo(db)
  };
}
