import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getDb, createRepositories, runMigrations, AiProviderIdentityConflictError } from "@ai-smartbook/db";
import {
  createAiProvider,
  AiGatewayError,
  resolveGuestAskRetentionDays,
  redactSensitiveText,
  selectGuestSystemPrompt,
  classifyCredentialVerification,
  healthForCredentialVerification,
  validateCredentialActivation,
  validateQwenEndpoint,
  buildStudentAnswer,
  publicStudentAnswer,
  type ProviderBillingMode,
  type StoredCredentialUsageScope,
} from "@ai-smartbook/ai";
import {
  hmacVisitorIp,
  resolveGuestAskIpHmacSecret,
  generateRecoveryToken,
  digestRecoveryToken
} from "@ai-smartbook/ai/server";
import { buildGateway } from "./ai/gateway-instance";
import { makeAnalyticsService, todayTaipei } from "./ai/analytics-service";
import { registerQmAdminBoundary } from "./ai/qm-admin-boundary";
import { createQmRuntimeConfigService } from "./ai/qm-runtime-config";
import type { QmRuntimeConfigDeps } from "./ai/qm-status-api";
import { EvaluationServiceError, makeEvaluationService } from "./ai/evaluation-service";
import { LiveEvaluationServiceError, makeLiveEvaluationService } from "./ai/live-evaluation-service";
import { EvaluationGovernanceError, makeEvaluationGovernanceService } from "./ai/evaluation-governance-service";
import { PilotServiceError, makePilotService } from "./ai/pilot-service";
import { loadRootEnv } from "./env";
import { isValidDateOnly, parseAnalyticsRange as parseAnalyticsDateRange } from "./ai/analytics-query";
import {
  createAiBudgetPolicyInputSchema,
  updateAiBudgetPolicyInputSchema,
  upsertAiProviderConfigInputSchema,
  createAiCredentialInputSchema,
  updateAiCredentialInputSchema,
  createAiCredentialModelQuotaInputSchema,
  updateAiCredentialModelQuotaInputSchema,
  createAiTokenPoolInputSchema,
  updateAiTokenPoolInputSchema,
  upsertAiLogicalModelInputSchema,
  updateAiLogicalModelInputSchema,
  updateAiModelDailyLimitInputSchema
} from "@ai-smartbook/schema";
import { decryptCredential, encryptCredential, credentialFingerprint, maskCredential } from "./ai/credential-crypto";
import { CredentialBackedProvider, defaultModelForManagedProvider } from "./ai/credential-provider";
import {
  parsePdfToContents,
  splitBookIntoChapters,
  buildChaptersFromContents,
  buildChaptersFromPdfOutline,
  buildChapterPreviewRowsFromPdfOutline,
  extractPdfOutline,
  buildPdfJsonIndex,
  normalizeChaptersToReaderOutline,
  normalizeReaderOutline,
  isStructuredReaderOutline,
  buildReaderTocFromIndexItems,
  getChapterPreviewApplyStatus,
  flattenReaderOutline,
  linkChaptersByPageRange,
  summarizeChapter,
  askBookQuestion,
  type BookCoreContext
} from "@ai-smartbook/book-core";
import {
  applyChapterPreviewInputSchema,
  bookFileRoleSchema,
  readerTocInputNodeSchema,
  readerTocFileSchema,
  readerTocImportPayloadSchema,
  generateReaderTocFromIndexInputSchema,
  createBookInputSchema,
  updateBookInputSchema,
  createChapterInputSchema,
  updateChapterInputSchema,
  chatRequestSchema,
  studentChatRequestSchema,
  appearanceSettingsSchema,
  appearanceSettingsUpdateSchema,
  setRiskLevelInputSchema,
  blockAccountInputSchema,
  generatePdfJsonIndexInputSchema,
  saveJsonIndexInputSchema,
  pdfJsonIndexSchema,
  createSmartBookNoteInputSchema,
  updateSmartBookNoteInputSchema,
  DEFAULT_APPEARANCE,
  DEFAULT_SITE_CONFIG,
  publicSiteConfigSchema,
  guestAnswerContentSchema,
  siteConfigSchema,
  siteConfigUpdateSchema,
  type AiJobType,
  type BookFile,
  type BookAiJob,
  type ChapterPreviewRow,
  type ChatSession,
  type ReaderOutlineNode,
  type ReaderTocInputNode,
  type ReaderTocImportPayload,
  type PdfJsonIndex,
  type StoredJsonIndexSummary
} from "@ai-smartbook/schema";

// Resolve the repository-root .env independently of the caller's cwd. Values
// already injected by the shell or deployment manager always win.
const rootEnv = loadRootEnv();
console.log(`ADMIN_API_TOKEN: ${rootEnv.adminTokenConfigured ? "configured" : "missing"}`);
console.log(`AI_CREDENTIAL_ENCRYPTION_KEY: ${rootEnv.credentialEncryptionKeyConfigured ? "configured" : "missing"}`);

const { db, sqlite } = getDb();
// Ensure the admin schema exists on the resolved DB path. This is idempotent
// and keeps `pnpm --filter AI-adm-D1 server:dev` working even before a manual
// `db:migrate` (it just yields an empty book list until you seed).
runMigrations(sqlite);
const repos = createRepositories(db);
const ai = createAiProvider();
const ctx: BookCoreContext = { repos, ai };

// Phase 2 AI Gateway (router + providers + budget + logging). Bootstrapped
// from env; always constructs even with no API keys (providers report
// unavailable and routing falls back to mock).
const { gateway: aiGateway, config: gatewayConfig } = buildGateway(repos);
// Dedicated HMAC secret for guest-ask IP identification (quota/risk signal
// only — recovery is authorized by a per-answer recovery token, never by IP).
// Production fails closed without GUEST_ASK_IP_HMAC_SECRET.
const guestAskIpHmacSecret = resolveGuestAskIpHmacSecret();
// Guest answer retention in days (clamped to [1, 90]); expired answers are
// purged on startup and opportunistically after new answer creation.
const guestAskRetentionDays = resolveGuestAskRetentionDays();
// Startup cleanup of expired guest answers. Best-effort: a failure logs but
// does not block serving questions (not a data-safety fail-closed path).
try {
  const { deleted } = repos.guestAskAnswers.cleanupExpired(new Date().toISOString());
  if (deleted > 0) {
    console.log(`[guest-ask] startup cleanup removed ${deleted} expired answer(s)`);
  }
} catch (err) {
  console.warn("[guest-ask] startup cleanup failed", err instanceof Error ? err.message : err);
}
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
// Scheduler execution is an explicit server-side opt-in. It only invokes the
// governance service's Fixture/Mock branch; Live is never accepted there.
if (process.env.AI_EVALUATION_SCHEDULER_ENABLED === "true") {
  const timer = setInterval(() => { void evaluationGovernanceService.runDue(new Date(), "scheduler"); }, 60_000);
  timer.unref();
}

const UPLOAD_ROOT = resolve(process.env.UPLOAD_DIR || resolve("./uploads", "books"));
const JSON_INDEX_ROLE = "json_index" as const;
const READER_TOC_ROLE = "reader_toc" as const;
const READER_TOC_SCHEMA_VERSION = "smartbook-reader-toc-v1";
const READER_TOC_SOURCE = "manual_admin_import" as const;
const READER_PROGRESS_SETTING_PREFIX = "reader-progress-v1";
const READER_PROGRESS_SOURCE_DEFAULT = "reader_toolbar";
const READER_KNOWLEDGE_SETTING_PREFIX = "reader-knowledge-v1";
const READER_KNOWLEDGE_DEFAULT_SUMMARY = "本章重點待整理";

const readerProgressRequestSchema = z.object({
  page: z.number().int().positive().optional(),
  chapterId: z.string().trim().min(1).optional(),
  eventType: z
    .enum(["page_view", "page_complete", "chapter_complete", "note_captured"])
    .default("page_view"),
  source: z.string().trim().min(1).max(64).optional()
});

const readerActionCompleteRequestSchema = z.object({
  page: z.number().int().positive().optional(),
  chapterId: z.string().trim().min(1).optional(),
  actionType: z.enum(["current_page", "current_chapter", "note_captured"]),
  source: z.string().trim().min(1).max(64).optional()
});

type ReaderProgressEventType = z.infer<typeof readerProgressRequestSchema>["eventType"];
type ReaderProgressState = {
  currentPage: number | null;
  currentChapterId: string | null;
  completedPages: number[];
  completedChapters: string[];
  updatedAt: string | null;
  lastEventType: ReaderProgressEventType | null;
};

type ReaderProgressSummary = {
  bookId: string;
  currentPage: number | null;
  currentChapterId: string | null;
  completedPagesCount: number;
  completedChapterIds: string[];
  completionPercentage: number | null;
  updatedAt: string | null;
};

type KnowledgePoint = {
  id: string;
  chapterId: string;
  title: string;
  summary: string;
  sourcePageStart: number | null;
  sourcePageEnd: number | null;
  importance: "low" | "medium" | "high";
  difficulty: "basic" | "intermediate" | "advanced";
  status: "available" | "completed";
};

type KnowledgePointState = {
  completedPointIds: string[];
  updatedAt: string | null;
};

type KnowledgePointListResponse = {
  bookId: string;
  chapterId?: string | null;
  points: KnowledgePoint[];
  completedPointsCount: number;
};

function decodeUploadFileName(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");

    if (decoded.includes("\uFFFD")) return name;
    if (/[一-鿿ぁ-ゟ゠-ヿ]/u.test(decoded)) return decoded;
    if (!/[^\x00-\x7F]/.test(name) && /[^\x00-\x7F]/.test(decoded)) return decoded;

    return name;
  } catch {
    return name;
  }
}

function sanitizeUploadFileName(name: string): string {
  const normalized = decodeUploadFileName(name).normalize("NFC");
  const safe = normalized
    .replace(/[\/\\]/g, "_")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\p{Pd}.\s()（）[\]【】]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim();

  return safe || "upload.pdf";
}

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = resolve(UPLOAD_ROOT, String(req.params.bookId));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const safe = sanitizeUploadFileName(file.originalname);
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// ---- Appearance image uploads (logo / banner icon) -----------------------
// Stored under a gitignored uploads dir and served read-only via /api/uploads.
const APPEARANCE_UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads", "appearance");
const APPEARANCE_IMAGE_TYPES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"]
]);
const appearanceUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      if (!existsSync(APPEARANCE_UPLOAD_DIR)) mkdirSync(APPEARANCE_UPLOAD_DIR, { recursive: true });
      cb(null, APPEARANCE_UPLOAD_DIR);
    },
    filename(_req, file, cb) {
      const ext = APPEARANCE_IMAGE_TYPES.get(file.mimetype) || "";
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    cb(null, APPEARANCE_IMAGE_TYPES.has(file.mimetype));
  }
});

/**
 * Wire the QM runtime-config service + bounded test probe to the live
 * repositories. The service stores only references in app_settings; the probe
 * reuses the same CredentialBackedProvider path as the credential-test route so
 * QM never guesses an unverified endpoint. The decrypted key lives only inside
 * the per-call adapter and is never written to process.env or returned.
 */
function createQmRuntimeConfigDeps(): QmRuntimeConfigDeps {
  const service = createQmRuntimeConfigService(repos.settings, {
    findProvider: (id) => {
      const row = repos.aiProviders.findConfig(id);
      return row ? {
        id: row.id, provider: row.provider, slug: row.slug, displayName: row.displayName,
        baseUrl: row.baseUrl, model: row.model, enabled: row.enabled
      } : null;
    },
    findCredential: (id) => {
      const row = repos.aiProviders.findCredential(id);
      return row ? {
        id: row.id, providerConfigId: row.providerConfigId, name: row.name,
        maskedApiKey: row.maskedApiKey, baseUrl: row.baseUrl, model: row.model,
        status: row.status as "active" | "standby" | "disabled", cooldownUntil: row.cooldownUntil
      } : null;
    },
    enabledModelsForCredential: (credentialId) => repos.aiCredentialModelQuotas.list(credentialId)
      .filter((quota) => quota.enabled)
      .map((quota) => quota.model)
  });
  return {
    service,
    buildProbe: (credentialId, carrier) => async (signal) => {
      const credential = repos.aiProviders.findCredential(credentialId);
      if (!credential) throw new Error("credential_not_found");
      const provider = repos.aiProviders.findConfig(credential.providerConfigId);
      if (!provider) throw new Error("provider_not_found");
      const managedProvider = provider.provider as "openai" | "gemini" | "kimi" | "qwen" | "zai";
      const adapter = new CredentialBackedProvider(
        managedProvider,
        repos,
        provider.model || defaultModelForManagedProvider(managedProvider),
        credential.id,
        "development_interactive",
        () => { carrier.setUpstreamRequestSent(); }
      );
      await adapter.generate({
        requestId: `qm_runtime_test_${randomUUID()}`,
        prompt: "Reply with OK.",
        maxOutputTokens: 8,
        signal
      });
      return { upstreamRequestSent: true };
    }
  };
}

const app = express();
app.use(express.json({ limit: "2mb" }));
// Serve uploaded appearance images read-only (rides the /api proxy in both apps).
app.use("/api/uploads/appearance", express.static(APPEARANCE_UPLOAD_DIR));
// Security boundary: every current and future admin route is protected here.
// Public and student routes are mounted outside this prefix and are unaffected.
registerQmAdminBoundary(app, process.env, createQmRuntimeConfigDeps());

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function publicEvaluationRun(row: {
  id: string;
  datasetId: string;
  datasetVersion: number;
  executionMode: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageScore: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalModelCalls: number;
  averageModelCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  conflictRate: number;
  unresolvedRate: number;
  baselineRunId: string | null;
  regressionIssueCount: number;
  trafficClass?: string;
  maxTokenBudget?: number | null;
  consumedTokens?: number;
  dailyBudgetSnapshot?: number | null;
  evaluationPoolId?: string | null;
  cancelRequestedAt?: string | null;
  cancelledAt?: string | null;
  preflightId?: string | null;
  logicalModelIdsJson?: string | null;
  providerIdsJson?: string | null;
  createdAt: string;
}) {
  return {
    id: row.id, datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: row.executionMode, status: row.status,
    startedAt: row.startedAt, completedAt: row.completedAt, totalCases: row.totalCases, passedCases: row.passedCases, failedCases: row.failedCases,
    passRate: row.passRate, averageScore: row.averageScore, averageDurationMs: row.averageDurationMs, p50DurationMs: row.p50DurationMs, p95DurationMs: row.p95DurationMs,
    totalModelCalls: row.totalModelCalls, averageModelCalls: row.averageModelCalls, totalInputTokens: row.totalInputTokens, totalOutputTokens: row.totalOutputTokens, totalTokens: row.totalTokens,
    conflictRate: row.conflictRate, unresolvedRate: row.unresolvedRate, baselineRunId: row.baselineRunId, regressionIssueCount: row.regressionIssueCount,
    trafficClass: row.trafficClass, maxTokenBudget: row.maxTokenBudget, consumedTokens: row.consumedTokens, dailyBudgetSnapshot: row.dailyBudgetSnapshot,
    evaluationPoolId: row.evaluationPoolId, cancelRequestedAt: row.cancelRequestedAt, cancelledAt: row.cancelledAt, preflightId: row.preflightId,
    logicalModelIds: row.logicalModelIdsJson ? JSON.parse(row.logicalModelIdsJson) : [], providerIds: row.providerIdsJson ? JSON.parse(row.providerIdsJson) : [], createdAt: row.createdAt
  };
}

function evaluationError(res: Response, error: unknown) {
  if (error instanceof EvaluationServiceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "evaluation request failed", code: "evaluation_failed" });
}

function liveEvaluationError(res: Response, error: unknown) {
  if (error instanceof LiveEvaluationServiceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "live evaluation request failed", code: "live_evaluation_failed" });
}

function evaluationGovernanceError(res: Response, error: unknown) {
  if (error instanceof EvaluationGovernanceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "evaluation governance request failed", code: "evaluation_governance_failed" });
}

function pilotServiceError(res: Response, error: unknown) {
  if (error instanceof PilotServiceError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: "pilot request failed", code: "pilot_failed" });
}

function providerValidationFailure(res: Response, error: z.ZodError) {
  const fields = Object.fromEntries(error.issues.map((issue) => [
    issue.path.join(".") || "provider",
    "欄位格式不正確"
  ]));
  return res.status(422).json({
    error: "Provider 欄位格式不正確",
    code: "validation_error",
    fields
  });
}

function providerFailure(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: message, code });
}

function credentialValidationFailure(res: Response, error: z.ZodError, extraFields?: Record<string, string>) {
  const fields = Object.fromEntries(error.issues.map((issue) => [
    issue.path.join(".") || "credential",
    "欄位格式不正確"
  ]));
  return res.status(422).json({
    error: "Credential 欄位格式不正確",
    message: "Credential 欄位格式不正確",
    code: "validation_error",
    fieldErrors: { ...fields, ...extraFields }
  });
}

function credentialFailure(res: Response, status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
  return res.status(status).json({
    error: message,
    message,
    code,
    ...(fieldErrors ? { fieldErrors } : {})
  });
}

function isUniqueCredentialStorageError(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function isPdfBookFile(file: BookFile): boolean {
  return file.fileType === "application/pdf" || file.fileName.toLowerCase().endsWith(".pdf");
}

function isPdfUpload(fileName: string, fileType: string): boolean {
  return fileType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
}

function isImageMimeType(mimeType: string): boolean {
  return /^image\//.test(mimeType);
}

function isImageFile(file: Pick<BookFile, "fileName" | "fileType">): boolean {
  return (
    isImageMimeType(file.fileType) ||
    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.fileName)
  );
}

function deleteStoredBookFile(file: BookFile): void {
  if (existsSync(file.filePath)) {
    unlinkSync(file.filePath);
  }
  repos.contents.deleteByFileId(file.id);
  repos.files.delete(file.id);
}

function parseIntFromString(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parsePageFromLabel(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/\d+/);
  if (!match) return null;
  return parseIntFromString(match[0]);
}

function stripPageLabelFromTitle(rawTitle: string): { title: string; page: number | null } {
  const trimmed = rawTitle.trim();
  const prefixed = trimmed.match(/^\[\s*p\.?\s*(\d+)\s*\]\s*(.+)$/i);
  if (prefixed) {
    return { title: prefixed[2].trim(), page: parseIntFromString(prefixed[1]) };
  }

  const suffixed = trimmed.match(/^(.*?)\s+(?:\[\s*)?p\.?\s*(\d+)\s*(?:\]|\))?\s*$/i);
  if (suffixed) {
    return { title: suffixed[1].trim(), page: parseIntFromString(suffixed[2]) };
  }

  return { title: trimmed, page: null };
}

function normalizeReaderTocNode(
  raw: {
    id?: string;
    title: string;
    level?: number;
    page?: number | null;
    displayPage?: string | null;
    children?: unknown;
  },
  inheritedLevel: number,
  path: string[],
  source: ReaderOutlineNode["source"] = "manual_toc"
): ReaderOutlineNode {
  const explicitLevel =
    typeof raw.level === "number" && Number.isInteger(raw.level) && raw.level > 0 ? raw.level : undefined;
  const level = explicitLevel ?? inheritedLevel;
  const pageFromDisplay = parsePageFromLabel(raw.displayPage ?? null);
  const page = parseIntFromString(String(raw.page ?? pageFromDisplay ?? "")) ?? null;
  const children = Array.isArray(raw.children) ? raw.children : [];
  return {
    id: raw.id ?? `${source}-${path.join("-")}`,
    title: raw.title.trim(),
    level,
    page,
    pdfPage: page,
    displayPage: raw.displayPage ?? (page != null ? String(page) : null),
    children: children.map((child, index) =>
      normalizeReaderTocNode(
        child as {
          id?: string;
          title: string;
          level?: number;
          page?: number | null;
          displayPage?: string | null;
          children?: unknown;
        },
        level + 1,
        [...path, String(index + 1)],
        source
      )
    ),
    source
  };
}

function normalizeReaderTocNodes(raw: ReaderTocInputNode[]): ReaderOutlineNode[] {
  return raw
    .filter((item) => item && typeof item === "object" && typeof item.title === "string" && item.title.trim())
    .map((item, index) =>
      normalizeReaderTocNode(
        {
          id: item.id,
          title: item.title,
          level: item.level,
          page: item.page,
          displayPage: item.displayPage,
          children: item.children
        },
        1,
        [`manual-toc-root`, String(index + 1)],
        "manual_toc"
      )
    );
}

function parseReaderTocMarkdown(content: string): ReaderOutlineNode[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const roots: ReaderOutlineNode[] = [];
  const stack: Array<{ level: number; node: ReaderOutlineNode }> = [];

  function add(level: number, title: string, page: number | null): ReaderOutlineNode | null {
    if (!title) return null;
    const node: ReaderOutlineNode = {
      id: `manual-toc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${roots.length + 1}`,
      title,
      level: Math.max(1, level),
      page,
      pdfPage: page,
      displayPage: page != null ? String(page) : null,
      children: [],
      source: "manual_toc"
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }

    stack.push({ level: node.level, node });
    return node;
  }

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^(#{1,2})\s+(.*)$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      const parsed = stripPageLabelFromTitle(headingMatch[2]);
      add(headingLevel, parsed.title, parsed.page);
      continue;
    }

    const bulletMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!bulletMatch) {
      continue;
    }

    const parsed = stripPageLabelFromTitle(bulletMatch[2]);
    // Bullet depth comes only from leading indentation, never from the current
    // stack top — otherwise flat sibling bullets cascade into deeper levels.
    const indent = Math.floor(bulletMatch[1].replace(/\t/g, "    ").length / 2);
    const level = 2 + indent;
    add(level, parsed.title, parsed.page);
  }

  return roots;
}

function toReaderTocInputNodes(nodes: ReaderOutlineNode[]): ReaderTocInputNode[] {
  return nodes.map((node) => ({
    id: node.id,
    title: node.title,
    level: node.level,
    page: node.page,
    displayPage: node.displayPage ?? null,
    children: toReaderTocInputNodes(node.children)
  }));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseReaderTocImportFromPayload(
  bookId: string,
  payload: ReaderTocImportPayload
): { file: { schemaVersion: string; bookId: string; source: string; items: ReaderTocInputNode[] }; outline: ReaderOutlineNode[] } {
  if (payload.format === "markdown") {
    const outline = parseReaderTocMarkdown(payload.content);
    if (outline.length === 0) {
      throw new Error("No valid TOC entries found in markdown content.");
    }
    return {
      outline,
      file: {
        schemaVersion: READER_TOC_SCHEMA_VERSION,
        bookId,
        source: READER_TOC_SOURCE,
        items: toReaderTocInputNodes(outline)
      }
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payload.content);
  } catch (error) {
    throw new Error("Invalid JSON content.");
  }

  if (isRecordValue(raw) && raw.schemaVersion === READER_TOC_SCHEMA_VERSION) {
    const parsed = readerTocFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Invalid JSON structure for manual TOC file.");
    }
    if (parsed.data.bookId !== bookId) {
      throw new Error(`JSON bookId mismatch: ${parsed.data.bookId}`);
    }
    const outline = normalizeReaderTocNodes(parsed.data.items);
    if (outline.length === 0) {
      throw new Error("JSON TOC payload has no outline items.");
    }
    return {
      outline,
      file: {
        schemaVersion: parsed.data.schemaVersion,
        bookId: parsed.data.bookId,
        source: parsed.data.source,
        items: parsed.data.items
      }
    };
  }

  const fallbackItems = readerTocInputNodeSchema.array().safeParse(raw);
  if (!fallbackItems.success) {
    throw new Error("Invalid JSON structure. Expect schemaVersion payload or a raw items array.");
  }
  const outline = normalizeReaderTocNodes(fallbackItems.data);
  if (outline.length === 0) {
    throw new Error("JSON TOC payload has no outline items.");
  }
  return {
    outline,
    file: {
      schemaVersion: READER_TOC_SCHEMA_VERSION,
      bookId,
      source: READER_TOC_SOURCE,
      items: fallbackItems.data
    }
  };
}

// ---- JSON index artifacts / QA reference ---------------------------------
// Stored JSON indexes are managed `book_files` with role "json_index". The
// active QA reference is a per-book pointer in app_settings (no migration).
const jsonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function qaReferenceKey(bookId: string): string {
  return `qa_reference:${bookId}`;
}
function getActiveQaReferenceId(bookId: string): string | null {
  return repos.settings.get(qaReferenceKey(bookId));
}
function setActiveQaReferenceId(bookId: string, fileId: string | null): void {
  repos.settings.set(qaReferenceKey(bookId), fileId ?? "");
}

/** Persist an index JSON to the book's upload dir and return the file path. */
function writeJsonIndexArtifact(bookId: string, baseName: string, json: PdfJsonIndex): string {
  const dir = resolve(UPLOAD_ROOT, bookId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safe = sanitizeUploadFileName(baseName).replace(/\.json$/i, "");
  const path = resolve(dir, `${Date.now()}_${safe || "index"}.json`);
  writeFileSync(path, JSON.stringify(json, null, 2), "utf8");
  return path;
}

/** Read + validate a stored JSON index file. Returns null when unparseable. */
function readStoredJsonIndex(file: BookFile): PdfJsonIndex | null {
  try {
    const parsed = pdfJsonIndexSchema.safeParse(JSON.parse(readFileSync(file.filePath, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function summarizeReaderToc(nodes: ReaderOutlineNode[]) {
  return { itemCount: flattenReaderOutline(nodes).length };
}

function readStoredReaderToc(file: BookFile): ReaderOutlineNode[] | null {
  if (file.role !== READER_TOC_ROLE) return null;
  try {
    const raw = JSON.parse(readFileSync(file.filePath, "utf8"));
    const parsed = readerTocFileSchema.safeParse(raw);
    if (!parsed.success) return null;
    return normalizeReaderTocNodes(parsed.data.items);
  } catch {
    return null;
  }
}

/** Persist a manual TOC JSON document as a managed book_file. */
function writeReaderTocArtifact(bookId: string, payload: { schemaVersion: string; bookId: string; source: string; items: unknown[] }) {
  const dir = resolve(UPLOAD_ROOT, bookId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${Date.now()}_reader_toc.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

function findLatestReaderTocFile(bookId: string): { file: BookFile | null; outline: ReaderOutlineNode[] | null } {
  const files = repos.files
    .findByBookId(bookId)
    .filter((file) => file.role === READER_TOC_ROLE)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const file of files) {
    const outline = readStoredReaderToc(file);
    if (outline) return { file, outline };
  }
  return { file: null, outline: null };
}

/** Build the lightweight admin-list summary for a stored JSON index file. */
function summarizeStoredJsonIndex(file: BookFile, activeId: string | null): StoredJsonIndexSummary {
  const index = readStoredJsonIndex(file);
  return {
    fileId: file.id,
    fileName: file.fileName,
    fileSize: file.fileSize,
    createdAt: file.createdAt,
    isActive: file.id === activeId,
    valid: index != null,
    level: index?.level ?? null,
    levelLabel: index?.levelLabel ?? null,
    itemCount: index?.itemCount ?? null,
    pageCount: index?.pageCount ?? null,
    generatedAt: index?.generatedAt ?? null,
    sourceFileId: index?.fileId ?? file.relatedFileId ?? null
  };
}

/**
 * Keyword-search the active JSON index (if any) and return a QA answer built
 * from its structured items. Returns null when there is no active index, it is
 * unparseable, or nothing matches — letting the caller fall back to content QA.
 */
function answerFromActiveJsonIndex(
  bookId: string,
  question: string
): { answer: string; matchedContentIds: string[] } | null {
  const activeId = getActiveQaReferenceId(bookId);
  if (!activeId) return null;
  const file = repos.files.findById(activeId);
  if (!file || file.bookId !== bookId || file.role !== JSON_INDEX_ROLE) return null;
  const index = readStoredJsonIndex(file);
  if (!index || index.items.length === 0) return null;

  const tokens = tokenizeQuestion(question);
  if (tokens.length === 0) return null;
  const scored = index.items
    .map((item) => {
      const text = item.text.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (scored.length === 0) return null;

  return {
    answer: [
      `根據結構化索引（${index.level} / ${index.levelLabel}）找到以下相關段落：`,
      ...scored.map((s, i) => {
        const range =
          s.item.pageStart === s.item.pageEnd
            ? `P${s.item.pageStart}`
            : `P${s.item.pageStart}-${s.item.pageEnd}`;
        return `${i + 1}. (${range}) ${s.item.text}`;
      })
    ].join("\n"),
    matchedContentIds: []
  };
}

async function replaceParsedContentsForFile(file: BookFile) {
  if (!isPdfBookFile(file)) {
    throw new Error("Only PDF source documents can be parsed.");
  }

  repos.contents.deleteByFileId(file.id);
  const { contents, pageCount } = await parsePdfToContents(file.filePath, file.bookId, file.id);
  repos.contents.createMany(contents);
  repos.files.updateParseStatus(file.id, "parsed");
  return { parsed: contents.length, pageCount };
}

function normalizePreviewRowsForApply(rows: ChapterPreviewRow[]): ChapterPreviewRow[] {
  return rows.map((row, index) => {
    const normalized: ChapterPreviewRow = {
      ...row,
      suggestedTitle: row.suggestedTitle.trim() || row.originalTitle.trim() || `Chapter ${index + 1}`,
      originalTitle: row.originalTitle.trim(),
      referenceTitle: row.referenceTitle?.trim() || null,
      printedPageLabel: row.printedPageLabel?.trim() || null,
      printedPageStart: row.printedPageStart?.trim() || null,
      printedPageEnd: row.printedPageEnd?.trim() || null,
      adminNote: row.adminNote?.trim() || null
    };
    return { ...normalized, applyStatus: getChapterPreviewApplyStatus(normalized) };
  });
}

const APPEARANCE_KEY = "appearance";
const SITE_CONFIG_KEY = "site-config";

const guestAskRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  category: z
    .enum(["auto", "programming", "math", "humanities", "cybersecurity", "教材問答"])
    .default("auto"),
  sourceType: z.enum(["manual", "image", "file"]).default("manual"),
  providerPreference: z.enum(["auto", "openai", "gemini", "kimi", "qwen", "zai"]).default("auto")
});

const guestFeedbackRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  helpful: z.boolean()
});

type GuestUsage = { day: string; count: number; lastAt: number };
const guestUsageByIp = new Map<string, GuestUsage>();

/** Load appearance settings merged over defaults (never throws / never blank). */
function loadAppearance() {
  const raw = repos.settings.get(APPEARANCE_KEY);
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    return appearanceSettingsSchema.parse({ ...DEFAULT_APPEARANCE, ...JSON.parse(raw) });
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Load public homepage settings from the shared settings table. */
function loadSiteConfig() {
  const raw = repos.settings.get(SITE_CONFIG_KEY);
  if (!raw) return DEFAULT_SITE_CONFIG;
  try {
    return siteConfigSchema.parse({ ...DEFAULT_SITE_CONFIG, ...JSON.parse(raw) });
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}

function getPublicSiteConfig() {
  return publicSiteConfigSchema.parse(loadSiteConfig());
}

function requireAdminAccess(req: Request, res: Response): boolean {
  // Kept as a defence-in-depth guard for the newer handlers. The canonical
  // policy is the `/api/admin` middleware registered above.
  if (process.env.NODE_ENV !== "production" && process.env.ADMIN_ALLOW_INSECURE_DEV === "true") {
    return true;
  }
  const expected = String(process.env.ADMIN_API_TOKEN || "").trim();
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      fail(res, 503, "admin API authentication is not configured");
      return false;
    }
    fail(res, 401, "admin authentication required");
    return false;
  }
  const candidate = (req.header("x-admin-token") || "").trim() ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (candidate !== expected) {
    fail(res, 401, "admin authentication required");
    return false;
  }
  return true;
}

/** Stable non-secret actor identifier for audit/preflight binding. */
function adminActorId(req: Request): string {
  const candidate = (req.header("x-admin-token") || req.header("authorization") || "").trim();
  return `admin:${createHash("sha256").update(candidate).digest("hex").slice(0, 24)}`;
}

function guestDayKey(): string {
  return todayTaipei();
}

function guestIdentity(req: Request): string {
  return resolveClientIp(req).ip || "anonymous";
}

function guestSystemPrompt(category: string, question: string): string {
  // Graph-theory and programming questions get specialised prompts; the base
  // guest prompt applies otherwise (spec §1).
  return selectGuestSystemPrompt(question, category);
}

function guestFailureMessage(error: AiGatewayError): string {
  switch (error.failureKind) {
    case "provider_timeout":
    case "gateway_timeout":
      return "AI 回答逾時，尚未完成產生，請重新產生。";
    case "provider_rate_limit":
      return "目前 AI 使用量較高，請稍後再試。";
    case "token_length":
      return "回答內容超過目前可處理範圍，請把問題拆成較小段後再試。";
    default:
      return error.publicMessage;
  }
}

function tokenizeQuestion(question: string): string[] {
  const grams = new Set<string>();
  for (const w of question.split(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/)) {
    const t = w.trim().toLowerCase();
    if (t.length >= 2 && /[a-z0-9]/.test(t)) grams.add(t);
  }
  const cleaned = question.replace(/[\s,，。．.!?？！、:：;；()「」『』\[\]]+/g, "").toLowerCase();
  for (let i = 0; i < cleaned.length - 1; i++) {
    grams.add(cleaned.slice(i, i + 2));
  }
  return [...grams];
}

function normalizeManualQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。．,.!?？！、:：;；()（）「」『』\[\]【】"'`]/g, "");
}

function similarityScore(input: string, candidate: string): number {
  const normalizedInput = normalizeManualQuestion(input);
  const normalizedCandidate = normalizeManualQuestion(candidate);
  if (!normalizedInput || !normalizedCandidate) return 0;
  if (normalizedInput === normalizedCandidate) return 1;
  if (
    normalizedInput.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedInput)
  ) {
    return 0.92;
  }

  const inputTokens = new Set(tokenizeQuestion(input));
  const candidateTokens = new Set(tokenizeQuestion(candidate));
  if (inputTokens.size === 0 || candidateTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of inputTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(inputTokens.size, candidateTokens.size);
}

function findManualQaAnswer(bookId: string, question: string) {
  const manualLogs = repos.qaLogs.findManualByBookId(bookId);
  let best: { question: string; answer: string; score: number } | null = null;

  for (const log of manualLogs) {
    const score = similarityScore(question, log.question);
    if (!best || score > best.score) {
      best = { question: log.question, answer: log.answer, score };
    }
  }

  return best && best.score >= 0.72 ? best : null;
}

function keywordChat(question: string, bookId: string, chapterId?: string | null) {
  // Prefer the active structured JSON index as the QA reference; fall back to
  // content-based search when there is no active index or it has no match.
  const fromIndex = answerFromActiveJsonIndex(bookId, question);
  if (fromIndex) return fromIndex;

  const tokens = tokenizeQuestion(question);
  const all = repos.contents.findByBookId(bookId);
  // Scope to the chapter's linked content when a chapter is selected and has
  // linked content; otherwise fall back to whole-book search.
  const scoped = chapterId ? all.filter((c) => c.chapterId === chapterId) : [];
  const contents = scoped.length > 0 ? scoped : all;

  if (tokens.length === 0 || contents.length === 0) {
    return {
      answer: "目前書本內容中沒有找到明確答案，請換個關鍵字再試一次。",
      matchedContentIds: []
    };
  }

  const scored = contents
    .map((c) => {
      const text = c.contentText.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    return {
      answer: "目前書本內容中沒有找到明確答案，請換個關鍵字再試一次。",
      matchedContentIds: []
    };
  }

  return {
    answer: [
      "根據書本內容，找到以下相關段落：",
      ...scored.map((s, i) => `${i + 1}. ${s.c.contentText}`)
    ].join("\n"),
    matchedContentIds: scored.map((s) => s.c.id)
  };
}

type ClientInfo = {
  userAgent: string | null;
  browserName: string;
  browserVersion: string | null;
  osName: string;
  osVersion: string | null;
  deviceType: string;
  deviceVendor: string | null;
  deviceModel: string | null;
  ipAddress: string | null;
  ipSource: string | null;
};

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "";
}

// ---- Server-side IP resolution -------------------------------------------
// We never trust a client-supplied IP. When TRUST_PROXY=true (e.g. behind
// Nginx / Cloudflare) we honour the standard forwarding headers in a fixed
// priority order; otherwise we only trust the raw socket address.
const TRUST_PROXY = String(process.env.TRUST_PROXY).toLowerCase() === "true";

/** Normalize IPv6 localhost and IPv4-mapped IPv6 to their IPv4 form. */
function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip === "") return "";
  if (ip === "::1") return "127.0.0.1";
  // Strip an IPv4-mapped IPv6 prefix, e.g. ::ffff:127.0.0.1 -> 127.0.0.1.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  return ip;
}

/** Resolve the client IP and record which source it came from. */
function resolveClientIp(req: Request): { ip: string | null; source: string | null } {
  if (TRUST_PROXY) {
    const cf = headerValue(req, "cf-connecting-ip").trim();
    if (cf) return { ip: normalizeIp(cf), source: "cf-connecting-ip" };
    const xff = headerValue(req, "x-forwarded-for").split(",")[0]?.trim();
    if (xff) return { ip: normalizeIp(xff), source: "x-forwarded-for" };
    const xreal = headerValue(req, "x-real-ip").trim();
    if (xreal) return { ip: normalizeIp(xreal), source: "x-real-ip" };
  }
  const socket = req.socket?.remoteAddress ?? "";
  const ip = normalizeIp(socket);
  return { ip: ip || null, source: ip ? "socket" : null };
}

/** Private/loopback/link-local IPv4 or IPv6 — never sent to external geo. */
function isPrivateIp(ip: string | null): boolean {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  if (ip === "::1" || ip === "0.0.0.0" || ip === "::") return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; // link-local
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(ip)) return true; // IPv6 ULA
  if (/^fe80:/i.test(ip)) return true; // IPv6 link-local
  return false;
}

/**
 * Human-readable location label for the admin table. We do not call any paid
 * external geolocation service: private/local IPs show a fixed label and public
 * IPs show stored geo fields when present, otherwise "Unknown".
 */
function describeIpLocation(session: ChatSession): string {
  const ip = session.lastIpAddress ?? null;
  if (!ip) return "—";
  if (isPrivateIp(ip)) return "Localhost / Private IP";
  const parts = [session.lastIpCity, session.lastIpRegion, session.lastIpCountry]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(", ") : "Unknown";
}

function normalizeOs(rawPlatform: string, userAgent: string) {
  const platform = rawPlatform.replace(/"/g, "").trim().toLowerCase();
  const ua = userAgent.toLowerCase();

  if (platform.includes("ios") || /iphone|ipad|ipod/.test(ua)) {
    const match = userAgent.match(/OS (\d+(?:[_\.\d]+)?)/i);
    return { name: "iOS", version: match ? match[1].replace(/_/g, ".") : null };
  }
  if (platform.includes("android") || /android/.test(ua)) {
    const match = userAgent.match(/Android (\d+(?:\.\d+)?)/i);
    return { name: "Android", version: match ? match[1] : null };
  }
  if (platform.includes("mac") || /mac os x/.test(ua)) {
    const match = userAgent.match(/Mac OS X (\d+(?:[_\.\d]+)?)/i);
    return { name: "macOS", version: match ? match[1].replace(/_/g, ".") : null };
  }
  if (platform.includes("win") || /windows nt/.test(ua)) {
    const match = userAgent.match(/Windows NT ([0-9.]+)/i);
    return { name: "Windows", version: match ? match[1] : null };
  }
  if (platform.includes("linux") || /linux|x11/.test(ua)) {
    return { name: "Linux", version: null };
  }
  return { name: "未知", version: null };
}

function normalizeBrowser(secChUa: string, userAgent: string) {
  const ch = secChUa.toLowerCase();

  if (ch.includes("microsoft edge") || /Edg\/([0-9.]+)/.test(userAgent)) {
    return {
      name: "Edge",
      version:
        userAgent.match(/Edg\/([0-9.]+)/)?.[1] ??
        secChUa.match(/Microsoft Edge";v="([^"]+)"/i)?.[1] ??
        null
    };
  }
  if (/Firefox\/([0-9.]+)/.test(userAgent)) {
    return { name: "Firefox", version: userAgent.match(/Firefox\/([0-9.]+)/)?.[1] ?? null };
  }
  if (
    (ch.includes("google chrome") || ch.includes("chromium") || /Chrome\/([0-9.]+)/.test(userAgent)) &&
    !/Edg\/|OPR\//.test(userAgent)
  ) {
    return {
      name: "Chrome",
      version:
        userAgent.match(/Chrome\/([0-9.]+)/)?.[1] ??
        secChUa.match(/(?:Google Chrome|Chromium)";v="([^"]+)"/i)?.[1] ??
        null
    };
  }
  if (
    /Version\/([0-9.]+).+Safari\//.test(userAgent) &&
    !/Chrome\/|Chromium\/|Edg\//.test(userAgent)
  ) {
    return { name: "Safari", version: userAgent.match(/Version\/([0-9.]+)/)?.[1] ?? null };
  }
  return { name: "未知", version: null };
}

function normalizeDeviceType(rawMobile: string, userAgent: string, osName: string) {
  const mobile = rawMobile.replace(/"/g, "").trim().toLowerCase();
  const ua = userAgent.toLowerCase();

  if (/ipad|tablet/.test(ua)) return "Tablet";
  if (mobile === "?1") return /ipad|tablet/.test(ua) ? "Tablet" : "Mobile";
  if (mobile === "?0") {
    if (osName === "Android" && /tablet/.test(ua)) return "Tablet";
    return "Desktop";
  }
  if (/iphone|ipod|mobile/.test(ua)) return "Mobile";
  if (osName === "Android") return /mobile/.test(ua) ? "Mobile" : "Tablet";
  if (osName === "Windows" || osName === "macOS" || osName === "Linux") return "Desktop";
  return "未知";
}

function detectDeviceModel(userAgent: string, osName: string) {
  if (osName === "iOS") {
    if (/iPad/i.test(userAgent)) return { vendor: "Apple", model: "iPad" };
    if (/iPhone/i.test(userAgent)) return { vendor: "Apple", model: "iPhone" };
  }
  const androidMatch = userAgent.match(/Android [^;)]*;\s*([^;)]+?)\s+Build\//i);
  if (androidMatch) {
    return { vendor: null, model: androidMatch[1].trim() || null };
  }
  return { vendor: null, model: null };
}

function parseClientInfo(req: Request): ClientInfo {
  const userAgent = headerValue(req, "user-agent").trim();
  const secChUa = headerValue(req, "sec-ch-ua");
  const secChUaPlatform = headerValue(req, "sec-ch-ua-platform");
  const secChUaMobile = headerValue(req, "sec-ch-ua-mobile");

  const os = normalizeOs(secChUaPlatform, userAgent);
  const browser = normalizeBrowser(secChUa, userAgent);
  const deviceType = normalizeDeviceType(secChUaMobile, userAgent, os.name);
  const device = detectDeviceModel(userAgent, os.name);
  const resolvedIp = resolveClientIp(req);

  return {
    userAgent: userAgent || null,
    browserName: browser.name,
    browserVersion: browser.version,
    osName: os.name,
    osVersion: os.version,
    deviceType,
    deviceVendor: device.vendor,
    deviceModel: device.model,
    ipAddress: resolvedIp.ip,
    ipSource: resolvedIp.source
  };
}

function enrichSessionClientInfo(existing: ChatSession | null, next: ClientInfo) {
  const keep = (current?: string | null, incoming?: string | null) =>
    incoming && incoming !== "未知" ? incoming : current ?? null;
  return {
    lastSeenAt: new Date().toISOString(),
    userAgent: keep(existing?.userAgent, next.userAgent),
    osName: keep(existing?.osName, next.osName) ?? "未知",
    osVersion: keep(existing?.osVersion, next.osVersion),
    browserName: keep(existing?.browserName, next.browserName) ?? "未知",
    browserVersion: keep(existing?.browserVersion, next.browserVersion),
    deviceType: keep(existing?.deviceType, next.deviceType) ?? "未知",
    deviceVendor: keep(existing?.deviceVendor, next.deviceVendor),
    deviceModel: keep(existing?.deviceModel, next.deviceModel),
    // Always refresh the IP to the latest request; keep prior geo (we do not
    // resolve geo yet, so these stay null unless a GeoIP provider is added).
    lastIpAddress: next.ipAddress ?? existing?.lastIpAddress ?? null,
    lastIpCountry: existing?.lastIpCountry ?? null,
    lastIpRegion: existing?.lastIpRegion ?? null,
    lastIpCity: existing?.lastIpCity ?? null,
    lastIpSource: next.ipSource ?? existing?.lastIpSource ?? null
  };
}

function findPublishedBook(bookId: string) {
  const book = repos.books.findById(bookId);
  if (!book || book.status !== "published") return null;
  return book;
}

function findPrimaryPdfSourceFile(bookId: string): BookFile | null {
  return (
    repos.files
      .findByBookId(bookId)
      .find((file) => file.role === "source_document" && isPdfBookFile(file)) ?? null
  );
}

function toPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function dedupeSortedNumbers(values: Array<number | null | undefined>): number[] {
  const set = new Set<number>();
  for (const value of values) {
    const n = toPositiveInt(value);
    if (n !== null) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function distinctStringValues(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function progressSettingKey(bookId: string, sessionId: string) {
  return `${READER_PROGRESS_SETTING_PREFIX}:${bookId}:${sessionId}`;
}

function knowledgeSettingKey(bookId: string, sessionId: string) {
  return `${READER_KNOWLEDGE_SETTING_PREFIX}:${bookId}:${sessionId}`;
}

function readKnowledgePointState(bookId: string, sessionId: string): KnowledgePointState {
  const raw = repos.settings.get(knowledgeSettingKey(bookId, sessionId));
  if (!raw) {
    return {
      completedPointIds: [],
      updatedAt: null
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<KnowledgePointState>;
    return {
      completedPointIds: distinctStringValues(Array.isArray(parsed.completedPointIds) ? parsed.completedPointIds : []),
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : null
    };
  } catch {
    return {
      completedPointIds: [],
      updatedAt: null
    };
  }
}

function writeKnowledgePointState(bookId: string, sessionId: string, state: KnowledgePointState): void {
  repos.settings.set(knowledgeSettingKey(bookId, sessionId), JSON.stringify(state));
}

function buildKnowledgePointsForBook(bookId: string): KnowledgePoint[] {
  return repos.chapters.findByBookId(bookId).map((chapter) => ({
    id: `kp_${chapter.id}`,
    chapterId: chapter.id,
    title: chapter.title,
    summary: chapter.summary?.trim() || READER_KNOWLEDGE_DEFAULT_SUMMARY,
    sourcePageStart: chapter.pageStart ?? null,
    sourcePageEnd: chapter.pageEnd ?? null,
    importance: "medium",
    difficulty: "basic",
    status: "available"
  }));
}

function enrichKnowledgePointWithCompletion(
  point: Omit<KnowledgePoint, "status">,
  completedPointIds: string[]
): KnowledgePoint {
  return {
    ...point,
    status: completedPointIds.includes(point.id) ? "completed" : "available"
  };
}

function getKnowledgePointsForBook(
  bookId: string,
  sessionId: string,
  chapterId?: string | null
): KnowledgePointListResponse {
  const all = buildKnowledgePointsForBook(bookId);
  const target = chapterId ? all.filter((point) => point.chapterId === chapterId) : all;
  const state = readKnowledgePointState(bookId, sessionId);
  const points = target.map((point) =>
    enrichKnowledgePointWithCompletion(point, state.completedPointIds)
  );
  return {
    bookId,
    chapterId: chapterId ?? null,
    points,
    completedPointsCount: points.filter((point) => point.status === "completed").length
  };
}

function getKnowledgePointById(bookId: string, pointId: string): KnowledgePoint | null {
  const all = buildKnowledgePointsForBook(bookId);
  const point = all.find((item) => item.id === pointId);
  return point ?? null;
}

function readReaderProgressState(bookId: string, sessionId: string): ReaderProgressState {
  const raw = repos.settings.get(progressSettingKey(bookId, sessionId));
  if (!raw) {
    return {
      currentPage: null,
      currentChapterId: null,
      completedPages: [],
      completedChapters: [],
      updatedAt: null,
      lastEventType: null
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReaderProgressState>;
    return {
      currentPage: toPositiveInt(parsed.currentPage),
      currentChapterId:
        typeof parsed.currentChapterId === "string" && parsed.currentChapterId.trim()
          ? parsed.currentChapterId.trim()
          : null,
      completedPages: dedupeSortedNumbers(Array.isArray(parsed.completedPages) ? parsed.completedPages : []),
      completedChapters: distinctStringValues(Array.isArray(parsed.completedChapters) ? parsed.completedChapters : []),
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : null,
      lastEventType:
        parsed.lastEventType === "page_view" ||
        parsed.lastEventType === "page_complete" ||
        parsed.lastEventType === "chapter_complete" ||
        parsed.lastEventType === "note_captured"
          ? parsed.lastEventType
          : null
    };
  } catch {
    return {
      currentPage: null,
      currentChapterId: null,
      completedPages: [],
      completedChapters: [],
      updatedAt: null,
      lastEventType: null
    };
  }
}

function writeReaderProgressState(bookId: string, sessionId: string, state: ReaderProgressState): void {
  repos.settings.set(progressSettingKey(bookId, sessionId), JSON.stringify(state));
}

function getChapterByIdOrNull(bookId: string, chapterId: string | null): { id: string } | null {
  if (!chapterId) return null;
  const chapter = repos.chapters.findById(chapterId);
  return chapter && chapter.bookId === bookId ? { id: chapter.id } : null;
}

function inferChapterByPage(bookId: string, page: number | null): string | null {
  if (!page) return null;
  for (const chapter of repos.chapters.findByBookId(bookId)) {
    if (!chapter.pageStart || !chapter.pageEnd) continue;
    if (page >= chapter.pageStart && page <= chapter.pageEnd) return chapter.id;
  }
  return null;
}

function markCompletedPages(state: ReaderProgressState, pages: number[]): ReaderProgressState {
  return {
    ...state,
    completedPages: dedupeSortedNumbers([...state.completedPages, ...pages]),
    updatedAt: new Date().toISOString()
  };
}

function markChapterComplete(
  bookId: string,
  state: ReaderProgressState,
  chapterId: string,
  currentPage: number | null
): ReaderProgressState {
  const chapter = repos.chapters.findById(chapterId);
  if (!chapter || chapter.bookId !== bookId) return state;
  const nextChapters = distinctStringValues([...state.completedChapters, chapter.id]);
  const completedPages = [...state.completedPages];

  if (typeof chapter.pageStart === "number" && typeof chapter.pageEnd === "number") {
    const start = Math.max(1, Math.min(chapter.pageStart, chapter.pageEnd));
    const end = Math.max(chapter.pageStart, chapter.pageEnd);
    for (let page = start; page <= end; page += 1) {
      completedPages.push(page);
    }
  }

  return {
    ...state,
    currentChapterId: chapter.id,
    currentPage: currentPage || state.currentPage,
    completedPages: dedupeSortedNumbers(completedPages),
    completedChapters: nextChapters,
    updatedAt: new Date().toISOString()
  };
}

function estimateTotalPages(bookId: string): number | null {
  const pages = repos.contents
    .findByBookId(bookId)
    .map((c) => c.pageNumber)
    .map(toPositiveInt)
    .filter((p): p is number => p !== null);

  const chapterEnds = repos
    .chapters
    .findByBookId(bookId)
    .map((c) => toPositiveInt(c.pageEnd))
    .filter((p): p is number => p !== null);

  const all = [...pages, ...chapterEnds];
  if (all.length === 0) return null;
  return Math.max(...all);
}

function summarizeReaderProgress(book: { id: string }, sessionId: string): ReaderProgressSummary {
  const state = readReaderProgressState(book.id, sessionId);
  const completedCount = state.completedPages.length;
  const inferredChapter = state.currentPage ? inferChapterByPage(book.id, state.currentPage) : null;
  const currentChapterId = state.currentChapterId || inferredChapter;
  const totalPages = estimateTotalPages(book.id);
  const completionPercentage =
    totalPages && totalPages > 0 ? Math.round((completedCount / totalPages) * 100) : null;

  return {
    bookId: book.id,
    currentPage: state.currentPage,
    currentChapterId,
    completedPagesCount: completedCount,
    completedChapterIds: state.completedChapters,
    completionPercentage,
    updatedAt: state.updatedAt
  };
}

function applyReaderProgressEvent(
  book: { id: string },
  state: ReaderProgressState,
  event: z.infer<typeof readerProgressRequestSchema>
): ReaderProgressState {
  const chapter = getChapterByIdOrNull(book.id, event.chapterId || null);
  if (event.eventType === "chapter_complete" && !chapter) {
    return state;
  }

  const next: ReaderProgressState = {
    ...state,
    currentPage: toPositiveInt(event.page) ?? state.currentPage,
    currentChapterId: chapter ? chapter.id : state.currentChapterId,
    lastEventType: event.eventType,
    updatedAt: new Date().toISOString()
  };

  if (next.currentPage != null && !next.currentChapterId) {
    next.currentChapterId = inferChapterByPage(book.id, next.currentPage);
  }

  if (event.eventType === "page_complete" && next.currentPage != null) {
    return markCompletedPages(next, [next.currentPage]);
  }

  if (event.eventType === "note_captured" && next.currentPage != null) {
    return markCompletedPages(next, [next.currentPage]);
  }

  if (event.eventType === "chapter_complete" && chapter) {
    return markChapterComplete(book.id, next, chapter.id, next.currentPage);
  }

  return next;
}

function resolveStudentSessionId(req: Request): string | null {
  return headerValue(req, "x-student-session-id").trim() || null;
}

function resolveStudentSession(
  req: Request,
  res: Response,
  bookId: string,
  options: { allowCreate: boolean; title?: string; sessionIdOverride?: string | null; requireSessionHeader?: boolean }
): { session: ChatSession; clientInfo: ClientInfo } | null {
  const sessionId = options.sessionIdOverride?.trim() || resolveStudentSessionId(req);
  const existingSession = sessionId ? repos.chat.findSessionById(sessionId) : null;

  if (sessionId && !existingSession) {
    fail(res, 401, "invalid session");
    return null;
  }
  if (existingSession && existingSession.bookId !== bookId) {
    fail(res, 403, "session is not allowed to access this book");
    return null;
  }
  if (rejectIfBlocked(req, res, existingSession)) return null;

  const clientInfo = parseClientInfo(req);
  if (!existingSession) {
    if (!options.allowCreate) {
      if (options.requireSessionHeader) {
        fail(res, 401, "x-student-session-id is required");
        return null;
      }
      fail(res, 401, "student session is required");
      return null;
    }
    const created = repos.chat.createSession({
      bookId,
      title: options.title ?? "Reader session",
      ...enrichSessionClientInfo(null, clientInfo)
    });
    return { session: created, clientInfo };
  }

  const updated =
    repos.chat.updateSessionClientInfo(
      existingSession.id,
      enrichSessionClientInfo(existingSession, clientInfo)
    ) ?? existingSession;
  return { session: updated, clientInfo };
}

interface ManualQaItem {
  question: string;
  answer: string;
}

function normalizeQaLabel(line: string): string {
  return line
    .replace(/^[#*\-\s>]+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function parseManualQaMarkdown(markdown: string): ManualQaItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: ManualQaItem[] = [];
  let currentQuestion = "";
  let answerLines: string[] = [];
  let mode: "idle" | "question" | "answer" = "idle";

  function flush() {
    const question = currentQuestion.trim();
    const answer = answerLines.join("\n").trim();
    if (question && answer) {
      items.push({ question, answer });
    }
    currentQuestion = "";
    answerLines = [];
    mode = "idle";
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const normalized = normalizeQaLabel(rawLine);

    if (/^(Q|Q\d+|Question|問題|問)[:：]\s*/i.test(normalized)) {
      flush();
      currentQuestion = normalized.replace(/^(Q|Q\d+|Question|問題|問)[:：]\s*/i, "").trim();
      mode = "question";
      continue;
    }

    if (/^(A|Answer|答案|答)[:：]\s*/i.test(normalized)) {
      answerLines = [normalized.replace(/^(A|Answer|答案|答)[:：]\s*/i, "").trim()];
      mode = "answer";
      continue;
    }

    if (mode === "question" && normalized !== "") {
      currentQuestion = [currentQuestion, normalized].filter(Boolean).join(" ").trim();
      continue;
    }

    if (mode === "answer") {
      if (line === "") {
        answerLines.push("");
      } else {
        answerLines.push(rawLine.trim());
      }
    }
  }

  flush();
  return items;
}

/** Wrap an AI operation as a tracked book_ai_job row. */
async function runJob<T>(
  bookId: string,
  jobType: AiJobType,
  input: unknown,
  fn: () => Promise<T>
): Promise<{ job: BookAiJob; result: T }> {
  const job = repos.aiJobs.create({
    bookId,
    jobType,
    status: "running",
    inputJson: redactSensitiveText(JSON.stringify(input ?? {}))
  });
  try {
    const result = await fn();
    const updated = repos.aiJobs.update(job.id, {
      status: "success",
      outputJson: redactSensitiveText(JSON.stringify(result))
    });
    return { job: updated ?? job, result };
  } catch (err) {
    repos.aiJobs.update(job.id, {
      status: "failed",
      errorMessage: "AI job failed"
    });
    throw err;
  }
}

// ---- Books ----------------------------------------------------------------
app.get("/api/admin/books", (_req, res) => {
  res.json({ books: repos.books.findAll() });
});

app.post("/api/admin/books", (req, res) => {
  const parsed = createBookInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  res.status(201).json({ book: repos.books.create(parsed.data) });
});

app.get("/api/admin/books/:bookId", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const chapters = repos.chapters.findByBookId(book.id);
  const files = repos.files.findByBookId(book.id);
  res.json({ book, chapters, files });
});

app.patch("/api/admin/books/:bookId", (req, res) => {
  const parsed = updateBookInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const book = repos.books.update(req.params.bookId, parsed.data);
  if (!book) return fail(res, 404, "book not found");
  res.json({ book });
});

// ---- Files & parsing ------------------------------------------------------
app.post("/api/admin/books/:bookId/files", upload.single("file"), (req, res) => {
  const book = repos.books.findById(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "file is required (multipart field 'file')");
  const rawDisplayName =
    typeof req.body?.displayName === "string" && req.body.displayName.trim() !== ""
      ? req.body.displayName
      : file.originalname;
  const displayName = sanitizeUploadFileName(rawDisplayName);
  const parsedRole = bookFileRoleSchema.safeParse(req.body?.role ?? "source_document");
  if (!parsedRole.success) return fail(res, 400, parsedRole.error.message);

  const role = parsedRole.data;
  if (role === READER_TOC_ROLE) {
    return fail(res, 400, "Use /reader-toc/import to create structured TOC files.");
  }
  const relatedFileId =
    typeof req.body?.relatedFileId === "string" && req.body.relatedFileId.trim() !== ""
      ? req.body.relatedFileId.trim()
      : null;

  if (role === "source_document" && !isPdfUpload(displayName, file.mimetype || "")) {
    return fail(res, 400, "Source documents must be uploaded as PDF files.");
  }

  if (role === "reference_image") {
    if (!isImageMimeType(file.mimetype || "")) {
      return fail(res, 400, "Reference images must use an image/* content type.");
    }
    if (!relatedFileId) {
      return fail(res, 400, "Reference images require a relatedFileId.");
    }
    const relatedFile = repos.files.findById(relatedFileId);
    if (!relatedFile || relatedFile.bookId !== book.id) {
      return fail(res, 404, "Related PDF file not found.");
    }
    if (!isPdfBookFile(relatedFile)) {
      return fail(res, 400, "Reference images can only be attached to a PDF source document.");
    }
  }

  const record = repos.files.create({
    bookId: book.id,
    fileName: displayName,
    filePath: file.path,
    fileType: file.mimetype || "application/octet-stream",
    fileSize: file.size,
    role,
    relatedFileId: role === "reference_image" ? relatedFileId : null,
    parseStatus: "pending"
  });
  res.status(201).json({ file: record });
});

app.get("/api/admin/books/:bookId/files/:fileId/raw", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  res.sendFile(file.filePath);
});

app.delete("/api/admin/books/:bookId/files/:fileId", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");

  try {
    for (const related of repos.files.findByRelatedFileId(file.id)) {
      deleteStoredBookFile(related);
    }
    deleteStoredBookFile(file);
  } catch (err) {
    return fail(res, 500, "delete file failed");
  }

  res.json({ deleted: true });
});

app.post("/api/admin/books/:bookId/files/:fileId/parse-content", async (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "content parsing requires a PDF source document");
  }

  try {
    const result = await replaceParsedContentsForFile(file);
    res.json({ ...result, fileId: file.id });
  } catch (err) {
    repos.files.updateParseStatus(file.id, "failed");
    fail(res, 500, "parse content failed");
  }
});

app.post("/api/admin/books/:bookId/files/:fileId/attach-reference-image", (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (!isImageFile(file)) return fail(res, 400, "only image files can be attached as reference images");

  const relatedFileId =
    typeof req.body?.relatedFileId === "string" && req.body.relatedFileId.trim() !== ""
      ? req.body.relatedFileId.trim()
      : "";
  if (!relatedFileId) return fail(res, 400, "relatedFileId is required");

  const relatedFile = repos.files.findById(relatedFileId);
  if (!relatedFile || relatedFile.bookId !== req.params.bookId) {
    return fail(res, 404, "related PDF file not found");
  }
  if (relatedFile.role !== "source_document" || !isPdfBookFile(relatedFile)) {
    return fail(res, 400, "reference images must be attached to a PDF source document");
  }

  const updated = repos.files.updateMetadata(file.id, {
    role: "reference_image",
    relatedFileId: relatedFile.id
  });
  if (!updated) return fail(res, 500, "failed to update file classification");
  res.json({ file: updated });
});

app.post("/api/admin/books/:bookId/files/:fileId/outline-preview", async (req, res) => {
  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== req.params.bookId) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "outline preview requires a PDF source document");
  }

  try {
    const { parsed, pageCount } = await replaceParsedContentsForFile(file);
    const rows = await buildChapterPreviewRowsFromPdfOutline(file.filePath, pageCount);
    res.json({ parsed, pageCount, rows });
  } catch (err) {
    repos.files.updateParseStatus(file.id, "failed");
    fail(res, 500, "outline preview failed");
  }
});

app.post("/api/admin/books/:bookId/files/:fileId/generate-json-index", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "JSON index generation requires a PDF source document");
  }

  const parsed = generatePdfJsonIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const { contents, pageCount } = await parsePdfToContents(file.filePath, book.id, file.id);
    const index = buildPdfJsonIndex({
      bookId: book.id,
      fileId: file.id,
      fileName: file.fileName,
      level: parsed.data.level,
      pageCount,
      contents,
      chapters: repos.chapters.findByBookId(book.id)
    });
    res.json({ index });
  } catch (err) {
    fail(res, 500, "generate json index failed");
  }
});

// Persist a JSON index as a managed json_index file. The request body carries
// only { level, setActive }; the server regenerates the (possibly very large)
// index from the PDF so the request never ships the full item array (no 413).
app.post("/api/admin/books/:bookId/files/:fileId/save-json-index", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const source = repos.files.findById(req.params.fileId);
  if (!source || source.bookId !== book.id) return fail(res, 404, "file not found");
  if (source.role !== "source_document" || !isPdfBookFile(source)) {
    return fail(res, 400, "saving a JSON index requires a PDF source document");
  }

  const parsed = saveJsonIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const { contents, pageCount } = await parsePdfToContents(source.filePath, book.id, source.id);
    const index = buildPdfJsonIndex({
      bookId: book.id,
      fileId: source.id,
      fileName: source.fileName,
      level: parsed.data.level,
      pageCount,
      contents,
      chapters: repos.chapters.findByBookId(book.id)
    });
    const baseName = `${source.fileName.replace(/\.pdf$/i, "")}-${index.level}-index`;
    const path = writeJsonIndexArtifact(book.id, baseName, index);
    const record = repos.files.create({
      bookId: book.id,
      fileName: `${baseName}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(index)),
      role: JSON_INDEX_ROLE,
      relatedFileId: source.id,
      parseStatus: "parsed"
    });
    if (parsed.data.setActive) setActiveQaReferenceId(book.id, record.id);
    res.status(201).json({ index: summarizeStoredJsonIndex(record, getActiveQaReferenceId(book.id)) });
  } catch (err) {
    fail(res, 500, "save json index failed");
  }
});

// Manually upload a JSON index file (validated against the v1 schema).
app.post("/api/admin/books/:bookId/json-indexes/upload", jsonUpload.single("file"), (req, res) => {
  const book = repos.books.findById(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "file is required (multipart field 'file')");

  let json: unknown;
  try {
    json = JSON.parse(file.buffer.toString("utf8"));
  } catch {
    return fail(res, 400, "Uploaded file is not valid JSON.");
  }
  const parsed = pdfJsonIndexSchema.safeParse(json);
  if (!parsed.success) {
    return fail(res, 400, `Invalid JSON index (smartbook-pdf-index-v1): ${parsed.error.message}`);
  }
  if (parsed.data.bookId !== book.id) {
    return fail(
      res,
      400,
      `This JSON index belongs to book ${parsed.data.bookId}, not the current book. Upload rejected.`
    );
  }

  try {
    const baseName = `${parsed.data.fileName.replace(/\.pdf$/i, "")}-${parsed.data.level}-index`;
    const path = writeJsonIndexArtifact(book.id, baseName, parsed.data);
    const record = repos.files.create({
      bookId: book.id,
      fileName: sanitizeUploadFileName(file.originalname) || `${baseName}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: file.size,
      role: JSON_INDEX_ROLE,
      relatedFileId: null,
      parseStatus: "parsed"
    });
    res.status(201).json({ index: summarizeStoredJsonIndex(record, getActiveQaReferenceId(book.id)) });
  } catch (err) {
    fail(res, 500, "upload json index failed");
  }
});

// List stored JSON index artifacts for the book (newest first).
app.get("/api/admin/books/:bookId/json-indexes", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const activeId = getActiveQaReferenceId(book.id);
  const indexes = repos.files
    .findByBookId(book.id)
    .filter((f) => f.role === JSON_INDEX_ROLE)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((f) => summarizeStoredJsonIndex(f, activeId));
  res.json({ indexes, activeId: activeId || null });
});

// Set a stored JSON index as the active Knowledge QA reference.
app.post("/api/admin/books/:bookId/json-indexes/:indexFileId/set-active-qa-reference", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== book.id || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  setActiveQaReferenceId(book.id, file.id);
  res.json({ activeId: file.id, index: summarizeStoredJsonIndex(file, file.id) });
});

// Stream a stored JSON index file (View / Download).
app.get("/api/admin/books/:bookId/json-indexes/:indexFileId/raw", (req, res) => {
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== req.params.bookId || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  res.type("application/json").sendFile(file.filePath);
});

// Delete a stored JSON index artifact (never touches the source PDF).
app.delete("/api/admin/books/:bookId/json-indexes/:indexFileId", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const file = repos.files.findById(req.params.indexFileId);
  if (!file || file.bookId !== book.id || file.role !== JSON_INDEX_ROLE) {
    return fail(res, 404, "JSON index not found");
  }
  try {
    deleteStoredBookFile(file);
    // Clearing the active reference falls QA back to content-based behavior.
    if (getActiveQaReferenceId(book.id) === file.id) setActiveQaReferenceId(book.id, null);
    res.json({ deleted: true });
  } catch (err) {
    fail(res, 500, "delete json index failed");
  }
});

app.post("/api/admin/books/:bookId/reader-toc/import", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const parsed = readerTocImportPayloadSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const { outline, file } = parseReaderTocImportFromPayload(book.id, parsed.data);
    const path = writeReaderTocArtifact(book.id, file);

    const previous = repos.files.findByBookId(book.id).filter((item) => item.role === READER_TOC_ROLE);
    for (const candidate of previous) {
      deleteStoredBookFile(candidate);
    }

    const record = repos.files.create({
      bookId: book.id,
      fileName: `${file.source}-${Date.now()}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(file), "utf8"),
      role: READER_TOC_ROLE,
      relatedFileId: null,
      parseStatus: "parsed"
    });

    res.status(201).json({
      source: "manual_toc",
      file: {
        fileId: record.id,
        fileName: record.fileName,
        createdAt: record.createdAt,
        itemCount: summarizeReaderToc(outline).itemCount
      },
      outline
    });
  } catch (err) {
    fail(res, 400, "import manual TOC failed");
  }
});

app.get("/api/admin/books/:bookId/reader-toc", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const latest = findLatestReaderTocFile(book.id);
  if (!latest.file || !latest.outline) {
    return res.json({ source: "manual_toc", file: null, outline: [] as ReaderOutlineNode[] });
  }

  res.json({
    source: "manual_toc",
    file: {
      fileId: latest.file.id,
      fileName: latest.file.fileName,
      createdAt: latest.file.createdAt,
      itemCount: summarizeReaderToc(latest.outline).itemCount
    },
    outline: latest.outline
  });
});

app.delete("/api/admin/books/:bookId/reader-toc", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const files = repos.files.findByBookId(book.id).filter((file) => file.role === READER_TOC_ROLE);
  if (files.length === 0) {
    return res.json({ deleted: 0 });
  }

  for (const file of files) {
    deleteStoredBookFile(file);
  }

  res.json({ deleted: files.length });
});

// Generate a compact reader TOC from an already-stored JSON index file. The
// large index never travels through the request body — only its file id + page
// range — so this avoids the 413 that pasting a full sentence index causes.
app.post("/api/admin/books/:bookId/reader-toc/generate-from-json-index", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const parsed = generateReaderTocFromIndexInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  const indexFile = repos.files.findById(parsed.data.jsonIndexFileId);
  if (!indexFile || indexFile.bookId !== book.id) return fail(res, 404, "JSON index not found");
  if (indexFile.role !== JSON_INDEX_ROLE) {
    return fail(res, 400, "Selected file is not a json_index file");
  }
  const index = readStoredJsonIndex(indexFile);
  if (!index) return fail(res, 400, "Stored JSON index is not a valid smartbook-pdf-index-v1 file");

  try {
    const { outline, lines, warnings } = buildReaderTocFromIndexItems(
      index.items,
      parsed.data.pageStart,
      parsed.data.pageEnd
    );
    if (outline.length === 0) {
      return fail(
        res,
        400,
        warnings[0] ?? "No chapter/section headings were found in the selected page range."
      );
    }

    const file = {
      schemaVersion: READER_TOC_SCHEMA_VERSION,
      bookId: book.id,
      source: READER_TOC_SOURCE,
      items: toReaderTocInputNodes(outline)
    };
    const path = writeReaderTocArtifact(book.id, file);

    // Replace any previous manual TOC so the latest one is the active source.
    for (const candidate of repos.files.findByBookId(book.id).filter((f) => f.role === READER_TOC_ROLE)) {
      deleteStoredBookFile(candidate);
    }
    const record = repos.files.create({
      bookId: book.id,
      fileName: `${READER_TOC_SOURCE}-${Date.now()}.json`,
      filePath: path,
      fileType: "application/json",
      fileSize: Buffer.byteLength(JSON.stringify(file), "utf8"),
      role: READER_TOC_ROLE,
      relatedFileId: indexFile.id,
      parseStatus: "parsed"
    });

    res.status(201).json({
      source: "manual_toc",
      file: {
        fileId: record.id,
        fileName: record.fileName,
        createdAt: record.createdAt,
        itemCount: summarizeReaderToc(outline).itemCount
      },
      outline,
      textPreview: lines.slice(0, 40).join("\n"),
      warnings
    });
  } catch (err) {
    fail(res, 500, "generate reader TOC failed");
  }
});

app.post("/api/admin/books/:bookId/files/:fileId/apply-chapters", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const file = repos.files.findById(req.params.fileId);
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "chapter apply requires a PDF source document");
  }

  const parsed = applyChapterPreviewInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  try {
    const normalizedRows = normalizePreviewRowsForApply(parsed.data.rows);
    const readyRows = normalizedRows
      .filter((row) => row.applyStatus === "ready")
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const hasFileContents = repos.contents.findByBookId(book.id).some((content) => content.fileId === file.id);
    if (!hasFileContents) {
      await replaceParsedContentsForFile(file);
    }

    repos.contents.unlinkChaptersByBookId(book.id);
    repos.chapters.deleteByBookId(book.id);

    repos.chapters.createMany(
      readyRows.map((row, index) => ({
        bookId: book.id,
        title: row.suggestedTitle,
        summary: row.adminNote ?? null,
        orderIndex: index,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        level: row.outlineLevel ?? 0,
        source: row.originalTitle ? "pdf_outline" : "manual",
        status: "draft"
      }))
    );

    const linked = linkChaptersByPageRange(ctx, book.id);
    res.json({
      applied: readyRows.length,
      skipped: normalizedRows.length - readyRows.length,
      linked,
      chapters: enrichChapters(book.id)
    });
  } catch (err) {
    fail(res, 500, "apply chapters failed");
  }
});

app.get("/api/admin/books/:bookId/contents", (req, res) => {
  res.json({ contents: repos.contents.findByBookId(req.params.bookId) });
});

app.delete("/api/admin/books/:bookId/contents", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  repos.contents.deleteByBookId(book.id);
  repos.files.resetParseStatusByBookId(book.id, "pending");

  res.json({ cleared: true });
});

// ---- Chapters -------------------------------------------------------------
/** Compute a chapter's content-link status from the book's parsed contents. */
function enrichChapters(bookId: string) {
  const chapters = repos.chapters.findByBookId(bookId);
  const contents = repos.contents.findByBookId(bookId);
  const bookHasContent = contents.length > 0;
  return chapters.map((c) => {
    const linkedContentCount = contents.filter((ct) => ct.chapterId === c.id).length;
    let contentLinkStatus: string;
    if (!bookHasContent) {
      contentLinkStatus = "missing_content";
    } else if (c.pageStart != null && c.pageEnd != null && c.pageEnd < c.pageStart) {
      contentLinkStatus = "page_range_invalid";
    } else if (linkedContentCount > 0) {
      contentLinkStatus = "linked";
    } else {
      contentLinkStatus = "unlinked";
    }
    return { ...c, contentLinkStatus, linkedContentCount };
  });
}

app.get("/api/admin/books/:bookId/chapters", (req, res) => {
  res.json({ chapters: enrichChapters(req.params.bookId) });
});

app.post("/api/admin/books/:bookId/chapters", (req, res) => {
  const parsed = createChapterInputSchema.safeParse({
    ...req.body,
    bookId: req.params.bookId
  });
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  res.status(201).json({ chapter: repos.chapters.create(parsed.data) });
});

app.patch("/api/admin/books/:bookId/chapters/:chapterId", (req, res) => {
  const parsed = updateChapterInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const chapter = repos.chapters.update(req.params.chapterId, parsed.data);
  if (!chapter) return fail(res, 404, "chapter not found");
  res.json({ chapter });
});

app.delete("/api/admin/books/:bookId/chapters/:chapterId", (req, res) => {
  const chapter = repos.chapters.findById(req.params.chapterId);
  if (!chapter || chapter.bookId !== req.params.bookId) return fail(res, 404, "chapter not found");
  // Detach any content linked to this chapter, then remove it.
  for (const c of repos.contents.findByChapterId(chapter.id)) {
    repos.contents.linkChapter(c.id, null);
  }
  repos.chapters.deleteById(chapter.id);
  res.json({ deleted: true });
});

// Idempotent rebuild: clear existing chapters + links, rebuild from outline
// (or content fallback), then link content by page range.
app.post("/api/admin/books/:bookId/chapters/build", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    repos.contents.unlinkChaptersByBookId(book.id);
    repos.chapters.deleteByBookId(book.id);
    const fromOutline = await buildChaptersFromPdfOutline(ctx, book.id);
    if (fromOutline.length === 0) await buildChaptersFromContents(ctx, book.id);
    linkChaptersByPageRange(ctx, book.id);
    res.json({ chapters: enrichChapters(book.id) });
  } catch (err) {
    fail(res, 500, "build chapters failed");
  }
});

// Re-link parsed content to chapters by page range (idempotent).
app.post("/api/admin/books/:bookId/chapters/link-content", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const linked = linkChaptersByPageRange(ctx, book.id);
  res.json({ linked, chapters: enrichChapters(book.id) });
});

// ---- AI modules -----------------------------------------------------------
app.post("/api/admin/books/:bookId/ai/split-book", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(book.id, "split_book", req.body, () =>
      splitBookIntoChapters(ctx, book.id)
    );
    res.json({ job, chapters: result });
  } catch (err) {
    fail(res, 500, "AI split-book service unavailable");
  }
});

app.post("/api/admin/books/:bookId/ai/build-chapters", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(book.id, "build_chapters", req.body, async () => {
      // Idempotent regeneration: clear existing chapters (and their content
      // links) first so pressing "一鍵生成" twice never stacks duplicates.
      repos.contents.unlinkChaptersByBookId(book.id);
      repos.chapters.deleteByBookId(book.id);

      // Prefer the PDF's built-in outline / bookmarks when available.
      const fromOutline = await buildChaptersFromPdfOutline(ctx, book.id);
      const built = fromOutline.length > 0 ? fromOutline : await buildChaptersFromContents(ctx, book.id);
      // Re-link content by page range so chapters report an accurate status.
      linkChaptersByPageRange(ctx, book.id);
      return built;
    });
    res.json({ job, chapters: result });
  } catch (err) {
    fail(res, 500, "AI build-chapters service unavailable");
  }
});

app.post("/api/admin/books/:bookId/chapters/:chapterId/ai/summarize", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  try {
    const { job, result } = await runJob(
      book.id,
      "summarize_chapter",
      { chapterId: req.params.chapterId },
      () => summarizeChapter(ctx, book.id, req.params.chapterId)
    );
    res.json({ job, chapter: result });
  } catch (err) {
    fail(res, 500, "AI summarize service unavailable");
  }
});

app.post("/api/admin/books/:bookId/qa", async (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  try {
    const { result } = await runJob(book.id, "book_qa", { question: parsed.data.question }, () =>
      askBookQuestion(ctx, book.id, parsed.data.question)
    );
    res.json({ answer: result.answer, context: result.contextChunks, log: result.log });
  } catch (err) {
    fail(res, 500, "AI QA service unavailable");
  }
});

app.post("/api/admin/books/:bookId/qa/import-markdown", (req, res) => {
  const book = repos.books.findById(req.params.bookId);
  if (!book) return fail(res, 404, "book not found");

  const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
  if (!markdown.trim()) return fail(res, 400, "markdown is required");

  const items = parseManualQaMarkdown(markdown);
  if (items.length === 0) {
    return fail(
      res,
      400,
      "no Q/A pairs found; use lines like 'Q: ...' and 'A: ...' in the markdown file"
    );
  }

  const created = repos.qaLogs.createMany(
    items.map((item) => ({
      bookId: book.id,
      question: item.question,
      answer: item.answer,
      contextJson: null,
      provider: "manual",
      model: "markdown"
    }))
  );

  res.status(201).json({ imported: created.length, logs: created });
});

app.get("/api/admin/books/:bookId/ai-jobs", (req, res) => {
  res.json({ jobs: repos.aiJobs.findByBookId(req.params.bookId) });
});

app.get("/api/admin/books/:bookId/qa-logs", (req, res) => {
  res.json({ logs: repos.qaLogs.findByBookId(req.params.bookId) });
});

// ---- Student read-only API -----------------------------------------------
app.get("/api/student/books", (_req, res) => {
  res.json({ mode: "repo-api", books: repos.books.findPublished() });
});

app.get("/api/student/books/:bookId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const chapters = repos.chapters.findByBookId(book.id);
  const pdfFile = findPrimaryPdfSourceFile(book.id);
  res.json({
    book: {
      ...book,
      chapters,
      pdfFileId: pdfFile?.id ?? null,
      pdfFileName: pdfFile?.fileName ?? null
    }
  });
});

app.get("/api/student/books/:bookId/outline", async (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const manualToc = findLatestReaderTocFile(book.id);
  if (manualToc.outline && manualToc.outline.length > 0) {
    return res.json({ bookId: book.id, source: "manual_toc", outline: manualToc.outline });
  }

  const jsonIndexFiles = repos.files
    .findByBookId(book.id)
    .filter((file) => file.role === JSON_INDEX_ROLE)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeId = getActiveQaReferenceId(book.id);
  const candidates = [
    ...jsonIndexFiles.filter((file) => {
      const index = readStoredJsonIndex(file);
      return index?.level === "chapter";
    }),
    ...jsonIndexFiles.filter((file) => file.id === activeId),
    ...jsonIndexFiles
  ];
  const seen = new Set<string>();

  for (const file of candidates) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    const index = readStoredJsonIndex(file);
    if (!index) continue;
    const outline = normalizeReaderOutline(index, "split_json");
    if (outline.length > 0 && isStructuredReaderOutline(outline)) {
      return res.json({ bookId: book.id, source: "split_json", outline });
    }
  }

  const chapters = repos.chapters.findByBookId(book.id);
  const outline = normalizeChaptersToReaderOutline(chapters, "chapter_table");
  if (outline.length > 0 && isStructuredReaderOutline(outline)) {
    return res.json({ bookId: book.id, source: "chapter_table", outline });
  }

  const sourcePdf = findPrimaryPdfSourceFile(book.id);
  if (sourcePdf && isPdfBookFile(sourcePdf) && existsSync(sourcePdf.filePath)) {
    const fallbackEntries = await extractPdfOutline(sourcePdf.filePath);
    const fallbackOutline = normalizeReaderOutline(
      fallbackEntries.map((entry, index) => ({
        id: `pdf-outline-${index + 1}`,
        title: entry.title,
        level: (entry.level ?? 0) + 1,
        page: entry.pageNumber,
        pdfPage: entry.pageNumber,
        displayPage: entry.pageNumber != null ? String(entry.pageNumber) : null,
        children: [],
        source: "pdf_outline" as const
      })),
      "pdf_outline"
    );
    if (fallbackOutline.length > 0) {
      return res.json({ bookId: book.id, source: "pdf_outline", outline: fallbackOutline });
    }
  }

  res.json({ bookId: book.id, source: "fallback", outline: [] });
});

app.get("/api/student/books/:bookId/contents", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  res.json({ contents: repos.contents.findByBookId(book.id) });
});

// ---- Smart Notes (text / ai_answer / canvas) -----------------------------
// Notes are scoped to a published book and optionally to chapter/page context.
app.get("/api/student/books/:bookId/notes", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  res.json({ notes: repos.notes.findByBookId(book.id) });
});

app.post("/api/student/books/:bookId/notes", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const parsed = createSmartBookNoteInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  if (parsed.data.type === "canvas" && !parsed.data.canvasData) {
    return fail(res, 400, "canvas notes require canvasData");
  }
  if (parsed.data.type !== "canvas" && !parsed.data.content?.trim()) {
    return fail(res, 400, "text/ai_answer notes require content");
  }
  res.status(201).json({ note: repos.notes.create(book.id, parsed.data) });
});

app.patch("/api/student/books/:bookId/notes/:noteId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const note = repos.notes.findById(String(req.params.noteId));
  if (!note || note.bookId !== book.id) return fail(res, 404, "note not found");
  const parsed = updateSmartBookNoteInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  res.json({ note: repos.notes.update(note.id, parsed.data) });
});

app.delete("/api/student/books/:bookId/notes/:noteId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const note = repos.notes.findById(String(req.params.noteId));
  if (!note || note.bookId !== book.id) return fail(res, 404, "note not found");
  repos.notes.delete(note.id);
  res.json({ deleted: true });
});

app.post("/api/student/books/:bookId/session", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: true,
    title: `Reader session · ${book.title}`,
    sessionIdOverride:
      typeof req.body?.sessionId === "string" && req.body.sessionId.trim() !== ""
        ? req.body.sessionId.trim()
        : null
  });
  if (!resolved) return;

  res.json({ sessionId: resolved.session.id });
});

app.get("/api/student/books/:bookId/files/:fileId/pdf-view", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const file = repos.files.findById(String(req.params.fileId));
  if (!file || file.bookId !== book.id) return fail(res, 404, "file not found");
  if (file.role !== "source_document" || !isPdfBookFile(file)) {
    return fail(res, 400, "file is not a PDF source document");
  }
  if (!existsSync(file.filePath)) return fail(res, 404, "file not found");

  repos.pdfAccessLogs.create({
    bookId: book.id,
    fileId: file.id,
    sessionId: resolved.session.id,
    ipAddress: resolved.clientInfo.ipAddress ?? null,
    userAgent: resolved.clientInfo.userAgent ?? null
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="reader.pdf"');
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file.filePath);
});

const BLOCKED_MESSAGE = "This account/session has been blocked by the administrator.";

/**
 * Reject (HTTP 403) a student request that must be blocked: either the referenced
 * session is explicitly blocked, or the resolved public IP matches a blocked
 * session. Private/local IPs are never IP-matched (that would block all
 * localhost dev), so for those only the explicit session block applies.
 * Returns true when a response was already sent.
 */
function rejectIfBlocked(req: Request, res: Response, session: ChatSession | null): boolean {
  if (session?.isBlocked) {
    fail(res, 403, BLOCKED_MESSAGE);
    return true;
  }
  const { ip } = resolveClientIp(req);
  if (ip && !isPrivateIp(ip) && repos.chat.isIpBlocked(ip)) {
    fail(res, 403, BLOCKED_MESSAGE);
    return true;
  }
  return false;
}

app.post("/api/student/books/:bookId/chat", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  // Accept both { message } (student UX) and { question } (legacy) bodies.
  const parsed = studentChatRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const question = parsed.data.message ?? parsed.data.question ?? "";
  if (!question.trim()) return fail(res, 400, "message is required");

  // Resolve or create a chat session bound to this book.
  let sessionId = parsed.data.sessionId;
  const requestClientInfo = parseClientInfo(req);

  // Enforce admin blocks before doing any work: reject a blocked session, or a
  // brand-new session opened from an already-blocked public IP.
  const existingSession = sessionId ? repos.chat.findSessionById(sessionId) : null;
  if (rejectIfBlocked(req, res, existingSession)) return;

  if (sessionId) {
    const session = existingSession;
    if (!session || session.bookId !== book.id) {
      sessionId = undefined;
    } else {
      repos.chat.updateSessionClientInfo(session.id, enrichSessionClientInfo(session, requestClientInfo));
    }
  }
  if (!sessionId) {
    sessionId = repos.chat.createSession({
      bookId: book.id,
      title: question.slice(0, 40),
      ...enrichSessionClientInfo(null, requestClientInfo)
    }).id;
  }

  // When a chapter is selected but has no linked content, tell the student to
  // re-link it in the admin instead of silently searching the whole book.
  const chapterId = parsed.data.chapterId;
  if (chapterId) {
    const chapter = repos.chapters.findById(chapterId);
    const chapterLinked =
      chapter && chapter.bookId === book.id
        ? repos.contents.findByChapterId(chapterId).length > 0
        : false;
    if (chapter && chapter.bookId === book.id && !chapterLinked) {
      const notice = "此章尚未建立可問答內容，請回後台重新連結內容。";
      repos.chat.addMessage({ sessionId, role: "user", content: question });
      repos.chat.addMessage({ sessionId, role: "assistant", content: notice });
      return res.json({
        sessionId,
        answer: notice,
        chatMode: "chapter-unlinked",
        source: "chapter_unlinked",
        provider: "system",
        model: "local",
        messages: repos.chat.findMessages(sessionId)
      });
    }
  }

  const manualAnswer = findManualQaAnswer(book.id, question);
  const result = manualAnswer
    ? {
        answer: `以下為老師整理的 Q&A：\n${manualAnswer.answer}`,
        chatMode: "manual-qa",
        source: "manual_qa",
        provider: "manual",
        model: "markdown",
        matchedQuestion: manualAnswer.question
      }
    : {
        ...keywordChat(question, book.id, chapterId),
        chatMode: "keyword",
        source: chapterId ? "chapter_contents" : "book_contents",
        provider: "keyword",
        model: "local"
      };
  repos.chat.addMessage({ sessionId, role: "user", content: question });
  repos.chat.addMessage({ sessionId, role: "assistant", content: result.answer });

  res.json({
    sessionId,
    ...result,
    messages: repos.chat.findMessages(sessionId)
  });
});

app.get("/api/student/books/:bookId/chat-sessions/:sessionId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  // Only expose sessions that belong to this published book.
  if (!session || session.bookId !== book.id) return fail(res, 404, "session not found");
  if (rejectIfBlocked(req, res, session)) return;
  repos.chat.updateSessionClientInfo(session.id, enrichSessionClientInfo(session, parseClientInfo(req)));
  res.json({ sessionId: session.id, messages: repos.chat.findMessages(session.id) });
});

app.get("/api/student/books/:bookId/progress-summary", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.post("/api/student/books/:bookId/progress", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const parsed = readerProgressRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  if (
    (parsed.data.eventType === "page_complete" ||
      parsed.data.eventType === "note_captured") &&
    !parsed.data.page
  ) {
    return fail(res, 400, "page is required for page_complete and note_captured");
  }

  if (parsed.data.eventType === "chapter_complete") {
    const chapter = getChapterByIdOrNull(book.id, parsed.data.chapterId ?? null);
    if (!chapter) {
      return fail(res, 400, "chapter not found");
    }
  }

  const current = readReaderProgressState(book.id, resolved.session.id);
  const next = applyReaderProgressEvent(book, current, {
    ...parsed.data,
    source: parsed.data.source?.trim() || READER_PROGRESS_SOURCE_DEFAULT
  });

  writeReaderProgressState(book.id, resolved.session.id, next);
  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.post("/api/student/books/:bookId/reader-actions/complete", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const parsed = readerActionCompleteRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  if (parsed.data.actionType === "current_chapter" && !parsed.data.chapterId) {
    return fail(res, 400, "chapterId is required for current_chapter");
  }

  if (parsed.data.actionType === "current_page" && !parsed.data.page) {
    return fail(res, 400, "page is required for current_page");
  }

  if (parsed.data.chapterId) {
    const chapter = getChapterByIdOrNull(book.id, parsed.data.chapterId);
    if (!chapter) {
      return fail(res, 400, "chapter not found");
    }
  }

  const mappedEvent: z.infer<typeof readerProgressRequestSchema> = {
    page: parsed.data.page,
    chapterId: parsed.data.chapterId,
    source: parsed.data.source?.trim() || READER_PROGRESS_SOURCE_DEFAULT,
    eventType:
      parsed.data.actionType === "current_page"
        ? "page_complete"
        : parsed.data.actionType === "current_chapter"
          ? "chapter_complete"
          : "note_captured"
  };

  const current = readReaderProgressState(book.id, resolved.session.id);
  if (mappedEvent.eventType === "chapter_complete" && !mappedEvent.chapterId) {
    return fail(res, 400, "chapterId is required for current_chapter");
  }
  const next = applyReaderProgressEvent(book, current, mappedEvent);
  writeReaderProgressState(book.id, resolved.session.id, next);
  res.json(summarizeReaderProgress(book, resolved.session.id));
});

app.get("/api/student/books/:bookId/knowledge-points", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const chapterIdRaw = req.query.chapterId;
  const chapterId =
    typeof chapterIdRaw === "string" && chapterIdRaw.trim() ? chapterIdRaw.trim() : null;
  if (chapterId) {
    const chapter = getChapterByIdOrNull(book.id, chapterId);
    if (!chapter) {
      return fail(res, 404, "chapter not found");
    }
  }

  res.json(getKnowledgePointsForBook(book.id, resolved.session.id, chapterId));
});

app.get("/api/student/books/:bookId/chapters/:chapterId/knowledge-points", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const chapter = getChapterByIdOrNull(book.id, String(req.params.chapterId));
  if (!chapter) return fail(res, 404, "chapter not found");

  res.json(getKnowledgePointsForBook(book.id, resolved.session.id, chapter.id));
});

app.get("/api/student/books/:bookId/knowledge-points/:pointId", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const point = getKnowledgePointById(book.id, String(req.params.pointId));
  if (!point) return fail(res, 404, "knowledge point not found");

  const state = readKnowledgePointState(book.id, resolved.session.id);
  res.json({
    bookId: book.id,
    point: enrichKnowledgePointWithCompletion(point, state.completedPointIds)
  });
});

app.post("/api/student/books/:bookId/knowledge-points/:pointId/complete", (req, res) => {
  const book = findPublishedBook(String(req.params.bookId));
  if (!book) return fail(res, 404, "book not found");

  const resolved = resolveStudentSession(req, res, book.id, {
    allowCreate: false,
    requireSessionHeader: true
  });
  if (!resolved) return;

  const point = getKnowledgePointById(book.id, String(req.params.pointId));
  if (!point) return fail(res, 404, "knowledge point not found");

  const state = readKnowledgePointState(book.id, resolved.session.id);
  const completedPointIds = distinctStringValues([...state.completedPointIds, point.id]);
  writeKnowledgePointState(book.id, resolved.session.id, {
    completedPointIds,
    updatedAt: new Date().toISOString()
  });

  const knowledgePointList = getKnowledgePointsForBook(book.id, resolved.session.id);
  res.json({
    bookId: book.id,
    point: enrichKnowledgePointWithCompletion(point, completedPointIds),
    completedPointsCount: knowledgePointList.completedPointsCount
  });
});

// ---- Admin dashboard / accounts ------------------------------------------
// There is no dedicated users/accounts table. "Accounts" are derived from chat
// sessions (one visitor session = one account proxy), with client info stored
// on the session from request headers.
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

/** Local-timezone YYYY-MM-DD key (avoids UTC cross-day miscounts). */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive lower bound (ms epoch) for a dashboard range filter. */
function rangeStartMs(range: string): number {
  const now = Date.now();
  if (range === "week") return now - 7 * 86_400_000;
  if (range === "month") return now - 30 * 86_400_000;
  return 0; // "all"
}

/** Last-activity time per session = latest message, else session createdAt. */
function lastSeenBySession(messages: { sessionId: string; createdAt: string }[]) {
  const map = new Map<string, number>();
  for (const m of messages) {
    const t = Date.parse(m.createdAt);
    if (t > (map.get(m.sessionId) ?? 0)) map.set(m.sessionId, t);
  }
  return map;
}

function sessionLastActivityMs(session: ChatSession, messageLastSeen: Map<string, number>) {
  const fromSession = Date.parse(session.lastSeenAt || session.createdAt);
  const fromMessages = messageLastSeen.get(session.id) ?? 0;
  return Math.max(fromSession, fromMessages);
}

app.get("/api/admin/dashboard/stats", (req, res) => {
  const range = String(req.query.range || "month");
  const sessions = repos.chat.listSessions();
  const messages = repos.chat.listAllMessages();
  const now = Date.now();
  const lastSeen = lastSeenBySession(messages);

  // One account proxy per session (no real user identity is tracked).
  const accountLast = sessions.map((s) => sessionLastActivityMs(s, lastSeen));
  const totalUsers = accountLast.length;
  const activeUsers = accountLast.filter((t) => now - t <= ONLINE_WINDOW_MS).length;
  const totalConversations = sessions.length;
  const totalMessages = messages.length;

  // Daily trend = student question records per local day, within range. This is
  // the same source as the student-question list so the two always agree.
  const start = rangeStartMs(range);
  const dayMap = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (Date.parse(m.createdAt) < start) continue;
    const key = localDateKey(m.createdAt);
    dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
  }
  const dailyConversations = [...dayMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ totalUsers, activeUsers, totalConversations, totalMessages, dailyConversations });
});

app.get("/api/admin/accounts", (_req, res) => {
  const sessions = repos.chat.listSessions();
  const messages = repos.chat.listAllMessages();
  const now = Date.now();
  const lastSeen = lastSeenBySession(messages);

  const accounts = sessions
    .map((s) => {
      const last = sessionLastActivityMs(s, lastSeen);
      return {
        id: s.userId || s.id,
        // Admin management actions always target the session row id.
        sessionId: s.id,
        name: s.title?.trim() || "匿名訪客",
        loginMethod: s.userId ? "帳號登入" : "匿名進入",
        osName: s.osName || "未知",
        deviceType: s.deviceType || "未知",
        browserName: s.browserName || "未知",
        ipAddress: s.lastIpAddress ?? null,
        ipLocation: describeIpLocation(s),
        riskLevel: (s.riskLevel as "safe" | "risk" | "dangerous") || "safe",
        riskNote: s.riskNote ?? null,
        isBlocked: !!s.isBlocked,
        blockedReason: s.blockedReason ?? null,
        blockedAt: s.blockedAt ?? null,
        lastSeenAt: new Date(last).toISOString(),
        online: now - last <= ONLINE_WINDOW_MS
      };
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  res.json({ accounts });
});

// Admin-only: set the risk marking (safe / risk / dangerous) for a session.
app.patch("/api/admin/accounts/:sessionId/risk", (req, res) => {
  const parsed = setRiskLevelInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  if (!session) return fail(res, 404, "account not found");
  const updated = repos.chat.setRiskLevel(session.id, parsed.data.riskLevel, parsed.data.note ?? null);
  res.json({ account: updated });
});

// Admin-only: block / unblock a session. A blocked session (and any other
// session sharing its public IP) is rejected by the student-facing endpoints.
app.patch("/api/admin/accounts/:sessionId/block", (req, res) => {
  const parsed = blockAccountInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  if (!session) return fail(res, 404, "account not found");
  const updated = repos.chat.setBlocked(session.id, parsed.data.blocked, parsed.data.reason ?? null);
  res.json({ account: updated });
});

app.get("/api/admin/student-questions", (_req, res) => {
  const sessions = repos.chat.listSessions();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bookById = new Map(repos.books.findAll().map((b) => [b.id, b]));
  const messages = repos.chat.listAllMessages();

  const questions = messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const session = sessionById.get(m.sessionId);
      const book = session ? bookById.get(session.bookId) : undefined;
      return {
        id: m.id,
        sessionId: m.sessionId,
        student: "匿名訪客",
        subject: book?.category || "未分類",
        content: m.content,
        createdAt: m.createdAt
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ questions });
});

app.delete("/api/admin/student-questions/:id", (req, res) => {
  repos.chat.deleteMessage(String(req.params.id));
  res.json({ deleted: true });
});

app.post("/api/admin/student-questions/delete", (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  for (const id of ids) repos.chat.deleteMessage(id);
  res.json({ deleted: ids.length });
});

// ---- Public homepage / guest AI ----------------------------------------
// These endpoints intentionally do not accept bookId. They are a small,
// rate-limited public flow. The response is atomic JSON: the browser never
// renders a provider chunk before the gateway has completed and persisted the
// answer, so a network/parser interruption cannot look like a successful reply.
app.get("/api/public/site-config", (_req, res) => {
  res.json(getPublicSiteConfig());
});

app.post("/api/public/guest-ask", async (req, res) => {
  const parsed = guestAskRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);

  const config = loadSiteConfig();
  if (!config.guestAiEnabled) {
    return res.status(503).json({
      status: "disabled",
      message: "目前暫停開放訪客問答，請登入後繼續使用學習功能。",
      requiresLoginForMore: true
    });
  }

  const identity = guestIdentity(req);
  const day = guestDayKey();
  const current = guestUsageByIp.get(identity);
  const usage: GuestUsage = current?.day === day ? current : { day, count: 0, lastAt: 0 };
  const remainingBefore = Math.max(0, config.guestDailyLimit - usage.count);

  if (remainingBefore <= 0) {
    return res.status(429).json({
      status: "limit_reached",
      message: "今日訪客體驗額度已使用完畢。",
      remainingGuestQuestions: 0,
      requiresLoginForMore: true
    });
  }

  const retryAfterSeconds = 20;
  const elapsed = Date.now() - usage.lastAt;
  if (usage.lastAt > 0 && elapsed < retryAfterSeconds * 1000) {
    const retryAfter = Math.max(1, Math.ceil((retryAfterSeconds * 1000 - elapsed) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      status: "rate_limited",
      message: `為維持服務品質，請約 ${retryAfter} 秒後再試。`,
      remainingGuestQuestions: remainingBefore,
      requiresLoginForMore: false,
      retryAfterSeconds: retryAfter
    });
  }

  // Count this request against the daily quota before calling the gateway so a
  // gateway failure still consumes the attempt (matches prior mock behaviour).
  usage.count += 1;
  usage.lastAt = Date.now();
  guestUsageByIp.set(identity, usage);
  const remainingGuestQuestions = Math.max(0, config.guestDailyLimit - usage.count);

  const requestId = `guest_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // IP HMAC is a quota/risk signal only. Recovery authorization uses the
  // high-entropy recovery token generated below; IP is never the sole auth.
  const visitorIpHmac = hmacVisitorIp(identity, guestAskIpHmacSecret);
  // Generate a 256-bit recovery token. The raw token is returned to the client
  // exactly once (below); only its HMAC digest is persisted. The token is the
  // sole credential for restoring this answer later.
  const recoveryToken = generateRecoveryToken();
  const recoveryTokenDigest = digestRecoveryToken(recoveryToken, guestAskIpHmacSecret);
  const expiresAt = new Date(Date.now() + guestAskRetentionDays * 86_400_000).toISOString();
  const clientAbortController = new AbortController();
  const onRequestAborted = () => clientAbortController.abort();
  const onResponseClosed = () => {
    if (!res.writableEnded) clientAbortController.abort();
  };
  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClosed);

  try {
    const { result } = await aiGateway.run({
      requestId,
      prompt: parsed.data.question,
      systemPrompt: guestSystemPrompt(parsed.data.category, parsed.data.question),
      requestSource: "guest",
      // Never persist the raw client IP as a quota scope key. The in-memory
      // rate limiter may use it transiently, but DB-backed usage uses the HMAC.
      scopeKey: visitorIpHmac,
      visitorIpHash: visitorIpHmac,
      clientSignal: clientAbortController.signal,
      preferredProvider: parsed.data.providerPreference === "auto" ? undefined : parsed.data.providerPreference
    });

    // Build the student response from an allowlisted answer contract. The raw
    // provider answer and completeness/routing diagnostics remain server-side.
    const studentAnswer = guestAnswerContentSchema.parse(
      publicStudentAnswer(buildStudentAnswer(parsed.data.question, result.answer))
    );
    const mode: "live" | "mock" = result.provider === "mock" ? "mock" : "live";
    const completion = result.completion ?? {
      complete: true,
      reasons: [],
      requestedItems: [],
      coveredItems: []
    };
    const answerStatus = completion.complete ? "success" : "incomplete";

    try {
      repos.guestAskAnswers.create({
        requestId,
        visitorIpHmac,
        recoveryTokenDigest,
        expiresAt,
        question: redactSensitiveText(parsed.data.question),
        answer: studentAnswer.markdownText,
        provider: result.provider,
        model: result.model,
        mode,
        status: answerStatus,
        finishReason: result.finishReason ?? null,
        completionJson: JSON.stringify(completion)
      });
    } catch {
      // Do not return an answer that the server failed to persist as if it were
      // durable. The provider result remains in the operational gateway log,
      // while the public response contains only a safe retry instruction.
      return res.status(500).json({
        requestId,
        status: "error",
        message: "回答已產生但保存失敗，請重新產生。",
        retryable: true,
        remainingGuestQuestions,
        requiresLoginForMore: false,
        error: {
          code: "AI_ANSWER_SAVE_FAILED",
          message: "回答保存失敗，請重新產生。",
          requestId
        }
      });
    }

    // Low-frequency opportunistic cleanup of expired answers, piggybacking on
    // answer creation so no separate scheduler is required. Best-effort; a
    // failure is swallowed so it never blocks normal Q&A.
    if (Math.random() < 0.02) {
      try {
        repos.guestAskAnswers.cleanupExpired(new Date().toISOString());
      } catch {
        /* opportunistic; ignore */
      }
    }

    res.json({
      requestId,
      status: answerStatus,
      // One-time recovery token. The client must store this to restore the
      // answer later; it is never returned again and never logged. Only its
      // HMAC digest is persisted server-side.
      recoveryToken,
      // The gateway validator and bounded provider maxOutputTokens are the
      // only answer limits. Never apply a second arbitrary character slice at
      // the API boundary.
      answer: studentAnswer.markdownText,
      structuredAnswer: studentAnswer,
      remainingGuestQuestions,
      requiresLoginForMore: remainingGuestQuestions === 0,
      retryable: !completion.complete,
      mode,
      quota: {
        used: usage.count,
        limit: config.guestDailyLimit,
        remaining: remainingGuestQuestions
      }
    });
  } catch (err) {
    if ((err instanceof AiGatewayError && err.failureKind === "client_abort") || req.aborted) {
      return;
    }
    if (err instanceof AiGatewayError) {
      const isBudget = err.code === "AI_BUDGET_EXCEEDED";
      return res.status(err.httpStatus).json({
        requestId,
        status: isBudget ? "limit_reached" : "error",
        message: guestFailureMessage(err),
        retryable: !isBudget && err.code !== "AI_INVALID_INPUT",
        remainingGuestQuestions,
        requiresLoginForMore: false,
        error: { code: err.code, message: err.publicMessage, requestId }
      });
    }
    return res.status(500).json({
      requestId,
      status: "error",
      message: "AI 服務目前暫時無法使用，請稍後再試。",
      remainingGuestQuestions,
      requiresLoginForMore: false,
      error: {
        code: "AI_INTERNAL",
        message: "AI 服務目前暫時無法使用，請稍後再試。",
        requestId
      }
    });
  } finally {
    req.off("aborted", onRequestAborted);
    res.off("close", onResponseClosed);
  }
});

/** Restore a saved answer. Auth = answerId + recovery token header (not IP). */
app.get("/api/public/guest-ask/:requestId", (req, res) => {
  const requestId = String(req.params.requestId || "");
  if (!/^guest_[a-f0-9]{16}$/.test(requestId)) return fail(res, 404, "answer not found");
  // Authorization is the per-answer recovery token. IP is deliberately not an
  // auth factor: shared NAT would let one visitor read another's answer. A
  // missing/wrong token or an expired answer all return the same generic 404.
  const token = String(req.header("x-guest-recovery-token") || "").trim();
  if (!token) return fail(res, 404, "answer not found");
  const providedDigest = digestRecoveryToken(token, guestAskIpHmacSecret);
  const saved = repos.guestAskAnswers.findActiveByRequestIdAndTokenDigest(
    requestId,
    providedDigest,
    new Date().toISOString()
  );
  if (!saved) return fail(res, 404, "answer not found");

  const studentAnswer = guestAnswerContentSchema.parse(
    publicStudentAnswer(buildStudentAnswer(saved.question, saved.answer))
  );
  const day = guestDayKey();
  const usage = guestUsageByIp.get(guestIdentity(req));
  const remaining = Math.max(0, loadSiteConfig().guestDailyLimit - (usage?.day === day ? usage.count : 0));
  const mode = saved.mode === "mock" ? "mock" : "live";
  res.json({
    requestId: saved.requestId,
    question: saved.question,
    status: saved.status,
    answer: studentAnswer.markdownText,
    structuredAnswer: studentAnswer,
    mode,
    remainingGuestQuestions: remaining,
    requiresLoginForMore: remaining === 0
  });
});

app.post("/api/public/guest-feedback", (req, res) => {
  const parsed = guestFeedbackRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  // Feedback is deliberately acknowledgement-only in mock mode. It can be
  // connected to an analytics repository later without changing the client.
  res.status(202).json({ accepted: true });
});

app.get("/api/admin/site-config", (_req, res) => {
  res.json({ config: loadSiteConfig() });
});

app.put("/api/admin/site-config", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = siteConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const merged = siteConfigSchema.parse({ ...loadSiteConfig(), ...parsed.data });
  repos.settings.set(SITE_CONFIG_KEY, JSON.stringify(merged));
  res.json({ config: merged, updatedAt: new Date().toISOString() });
});

// ---- AI provider / credential administration ----------------------------
// These endpoints deliberately map rows to a public shape; encryptedApiKey,
// fingerprint and transport envelope are never serialised.
function publicProviderConfig(row: ReturnType<typeof repos.aiProviders.listConfigs>[number]) {
  return { id: row.id, provider: row.provider, slug: row.slug, displayName: row.displayName, baseUrl: row.baseUrl,
    model: row.model, enabled: row.enabled, isDefault: row.isDefault, isRouterProvider: row.isRouterProvider,
    priority: row.priority, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function publicCredential(row: NonNullable<ReturnType<typeof repos.aiProviders.findCredential>>) {
  return { id: row.id, providerConfigId: row.providerConfigId, name: row.name, maskedApiKey: row.maskedApiKey,
    baseUrl: row.baseUrl, model: row.model, status: row.status, priority: row.priority, weight: row.weight,
    failureCount: row.failureCount, cooldownUntil: row.cooldownUntil, lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus, lastTestLatencyMs: row.lastTestLatencyMs, createdAt: row.createdAt,
    updatedAt: row.updatedAt, disabledAt: row.disabledAt,
    billingMode: row.billingMode,
    region: row.region,
    endpointProfile: row.endpointProfile,
    usageScope: row.usageScope,
    productionAuthorized: row.productionAuthorized,
    allowEvaluation: row.allowEvaluation,
    evaluationAuthorizedAt: row.evaluationAuthorizedAt,
    providerHealth: row.providerHealth,
    modelQuotas: repos.aiCredentialModelQuotas.list(row.id).map(publicModelQuota) };
}

function credentialActivationFailure(
  res: Response,
  provider: string,
  billingMode: ProviderBillingMode,
  usageScope: StoredCredentialUsageScope,
  productionAuthorized: boolean
) {
  const validation = validateCredentialActivation({ provider, billingMode, usageScope, productionAuthorized });
  if (validation.allowed) return undefined;
  return credentialFailure(res, 422, "credential_policy_violation", validation.message, {
    usageScope: validation.reason
  });
}

function publicModelQuota(row: ReturnType<typeof repos.aiCredentialModelQuotas.list>[number]) {
	  return {
	    id: row.id,
	    credentialId: row.credentialId,
	    model: row.model,
	    rpmLimit: row.rpmLimit,
	    tpmLimit: row.tpmLimit,
	    rpdLimit: row.rpdLimit,
	    requestsThisMinute: Math.max(0, row.requestsThisMinute),
	    tokensThisMinute: Math.max(0, row.tokensThisMinute),
	    requestsToday: Math.max(0, row.requestsToday),
	    minuteResetAt: row.minuteResetAt,
	    dailyResetAt: row.dailyResetAt,
	    resetTimezone: row.resetTimezone,
	    usageSource: row.usageSource === "provider_response" ? "provider_response" : "system_estimated",
	    enabled: row.enabled,
	    isDefault: row.isDefault,
	    // Pricing config fields (spec §5.1, §5.2). Exposed so the admin UI can
	    // display and edit per-model pricing. Historical usage logs keep their own
	    // immutable snapshot (spec §5.3), so editing prices here only affects
	    // future requests.
	    currency: row.currency,
	    serviceTier: row.serviceTier,
	    inputPriceUsdPerMillion: row.inputPriceUsdPerMillion,
	    outputPriceUsdPerMillion: row.outputPriceUsdPerMillion,
	    cachedInputPriceUsdPerMillion: row.cachedInputPriceUsdPerMillion,
	    cacheStorageUsdPerMillionTokenHour: row.cacheStorageUsdPerMillionTokenHour,
	    pricingEffectiveAt: row.pricingEffectiveAt,
	    pricingSource: row.pricingSource,
	    pricingUnavailable: row.pricingUnavailable,
	    createdAt: row.createdAt,
	    updatedAt: row.updatedAt,
	    remaining: {
	      rpm: row.rpmLimit === null ? null : Math.max(0, row.rpmLimit - row.requestsThisMinute),
	      tpm: row.tpmLimit === null ? null : Math.max(0, row.tpmLimit - row.tokensThisMinute),
	      rpd: row.rpdLimit === null ? null : Math.max(0, row.rpdLimit - row.requestsToday)
	    }
	  };
	}

function isMaskedCredentialValue(value: string, currentMask?: string): boolean {
  const normalized = value.trim();
  return Boolean(currentMask && normalized === currentMask)
    || normalized === "****"
    || /^[^*]{1,3}\*{4}[^*]{4}$/.test(normalized);
}

app.get("/api/admin/ai-providers", (_req, res) => {
  res.json({ providers: repos.aiProviders.listConfigs().map(publicProviderConfig) });
});
app.post("/api/admin/ai-providers", (req, res) => {
  const parsed = upsertAiProviderConfigInputSchema.safeParse(req.body);
  if (!parsed.success) return providerValidationFailure(res, parsed.error);
  let created: ReturnType<typeof repos.aiProviders.createConfig>;
  try {
    created = repos.aiProviders.createConfig(parsed.data);
  } catch (error) {
    if (error instanceof AiProviderIdentityConflictError) {
      return providerFailure(res, 409, "provider_identity_conflict", error.field === "slug" ? "此 Provider Slug 已存在，請使用其他 Slug。" : "此 Provider 顯示名稱已存在，請使用其他名稱。");
    }
    return providerFailure(res, 500, "unexpected_error", "Provider 建立失敗，請稍後再試。");
  }
  const row = created.row;
  repos.aiProviders.audit("provider.created_or_updated", "provider", row.id, { provider: row.provider });
  if (created.restored) repos.aiProviders.audit("provider.restored", "provider", row.id, { provider: row.provider });
  res.status(created.restored ? 200 : 201).json({
    provider: publicProviderConfig(row),
    code: created.restored ? "provider_restored" : "provider_created"
  });
});
app.put("/api/admin/ai-providers", (req, res) => {
  const parsed = upsertAiProviderConfigInputSchema.safeParse(req.body);
  if (!parsed.success) return providerValidationFailure(res, parsed.error);
  let row: ReturnType<typeof repos.aiProviders.upsertConfig>;
  try {
    row = repos.aiProviders.upsertConfig(parsed.data);
  } catch (error) {
    if (error instanceof AiProviderIdentityConflictError) {
      return providerFailure(res, 409, "provider_identity_conflict", error.field === "slug" ? "此 Provider Slug 已存在，請使用其他 Slug。" : "此 Provider 顯示名稱已存在，請使用其他名稱。");
    }
    return providerFailure(res, 500, "unexpected_error", "Provider 更新失敗，請稍後再試。");
  }
  repos.aiProviders.audit("provider.updated", "provider", row.id, { provider: row.provider });
  res.json({ provider: publicProviderConfig(row) });
});
app.delete("/api/admin/ai-providers/:id", (req, res) => {
  const id = String(req.params.id);
  const current = repos.aiProviders.findConfigIncludingDeleted(id);
  if (!current) return res.status(204).end();
  try {
    const result = repos.aiProviders.deleteConfig(id);
    // The repository is idempotent; a repeated DELETE never leaks secrets or
    // turns an already deleted resource into a 500.
    if (result.deleted) return res.status(204).end();
    return res.status(204).end();
  } catch (error) {
    if (error instanceof Error && error.message === "default router cannot be deleted") {
      return fail(res, 409, "此 Provider 是 Default Router，請先指定其他 Default Router 再刪除。");
    }
    return fail(res, 400, "Provider 無法刪除，請稍後再試。");
  }
});
app.get("/api/admin/ai-providers/:id/credentials", (req, res) => {
  const provider = repos.aiProviders.findConfig(String(req.params.id));
  if (!provider) return fail(res, 404, "provider not found");
  res.json({ credentials: repos.aiProviders.listCredentials(provider.id).map(publicCredential) });
});
app.get("/api/admin/ai-credentials/:credentialId/quotas", (req, res) => {
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  res.json({ quotas: repos.aiCredentialModelQuotas.list(credential.id).map(publicModelQuota) });
});
app.post("/api/admin/ai-credentials/:credentialId/quotas", (req, res) => {
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  const parsed = createAiCredentialModelQuotaInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "模型配額欄位格式不正確；上限須為正整數或留白");
  if (repos.aiCredentialModelQuotas.findForCredential(credential.id, parsed.data.model)) {
    return fail(res, 409, "同一 Credential 不可重複建立相同 Model 配額");
  }
  try {
    const row = repos.aiCredentialModelQuotas.create({ ...parsed.data, credentialId: credential.id });
    repos.aiProviders.audit("credential.model_quota.created", "credential_model_quota", row.id);
    return res.status(201).json({ quota: publicModelQuota(row) });
  } catch (error) {
    if (error instanceof Error && /default model/i.test(error.message)) return fail(res, 409, "預設模型必須保持啟用，請先指定其他預設模型");
    return fail(res, 400, "模型配額欄位格式不正確或時區不支援");
  }
});
app.put("/api/admin/ai-credential-quotas/:quotaId", (req, res) => {
  const current = repos.aiCredentialModelQuotas.find(String(req.params.quotaId));
  if (!current || !repos.aiProviders.findCredential(current.credentialId)) return fail(res, 404, "模型配額不存在");
  const parsed = updateAiCredentialModelQuotaInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "模型配額欄位格式不正確；上限須為正整數或留白");
  const duplicateModel = parsed.data.model
    ? repos.aiCredentialModelQuotas.findForCredential(current.credentialId, parsed.data.model)
    : undefined;
  if (duplicateModel && duplicateModel.id !== current.id) {
    return fail(res, 409, "同一 Credential 不可重複建立相同 Model 配額");
  }
  try {
    const row = repos.aiCredentialModelQuotas.update(current.id, parsed.data);
    if (!row) return fail(res, 404, "模型配額不存在");
    repos.aiProviders.audit("credential.model_quota.updated", "credential_model_quota", row.id);
    return res.json({ quota: publicModelQuota(row) });
  } catch (error) {
    if (error instanceof Error && /default model/i.test(error.message)) return fail(res, 409, "預設模型必須保持啟用，請先指定其他預設模型");
    return fail(res, 400, "模型配額欄位格式不正確或時區不支援");
  }
});
app.post("/api/admin/ai-credential-quotas/:quotaId/default", (req, res) => {
  const current = repos.aiCredentialModelQuotas.find(String(req.params.quotaId));
  if (!current || !repos.aiProviders.findCredential(current.credentialId)) return fail(res, 404, "模型配額不存在");
  try {
    const row = repos.aiCredentialModelQuotas.setDefault(current.id);
    if (!row) return fail(res, 404, "模型配額不存在");
    repos.aiProviders.audit("credential.model_quota.default_changed", "credential_model_quota", row.id);
    return res.json({ quota: publicModelQuota(row) });
  } catch {
    return fail(res, 409, "停用中的模型不可設為預設模型");
  }
});
app.delete("/api/admin/ai-credential-quotas/:quotaId", (req, res) => {
  const current = repos.aiCredentialModelQuotas.find(String(req.params.quotaId));
  if (!current) return res.status(204).end();
  if (!repos.aiProviders.findCredential(current.credentialId)) return res.status(204).end();
  try {
    repos.aiCredentialModelQuotas.remove(current.id);
  } catch {
    return fail(res, 409, "預設模型不可直接刪除，請先指定其他預設模型");
  }
  repos.aiProviders.audit("credential.model_quota.deleted", "credential_model_quota", current.id);
  return res.status(204).end();
});
app.post("/api/admin/ai-providers/:id/credentials", (req, res) => {
  const provider = repos.aiProviders.findConfig(String(req.params.id));
  if (!provider) return credentialFailure(res, 404, "provider_not_found", "Provider 不存在");
  const parsed = createAiCredentialInputSchema.safeParse(req.body);
  if (!parsed.success) return credentialValidationFailure(res, parsed.error);
  const policyFailure = credentialActivationFailure(
    res,
    provider.provider,
    parsed.data.billingMode,
    parsed.data.usageScope,
    parsed.data.productionAuthorized
  );
  if (policyFailure) return policyFailure;
  if (parsed.data.model && parsed.data.isDefaultModel === false) {
    return credentialFailure(res, 422, "validation_error", "Credential 欄位格式不正確", {
      isDefaultModel: "首次模型必須設為預設模型"
    });
  }
  if (isMaskedCredentialValue(parsed.data.apiKey)) {
    return credentialFailure(res, 422, "validation_error", "Credential 欄位格式不正確", {
      apiKey: "請輸入完整 API Key，不能使用遮罩值"
    });
  }
  if (repos.aiProviders.findCredentialByName(provider.id, parsed.data.name)) {
    return credentialFailure(res, 409, "credential_already_exists", "此 Credential 名稱已存在");
  }
  const fingerprint = credentialFingerprint(parsed.data.apiKey);
  if (repos.aiProviders.findByFingerprint(fingerprint)) {
    return credentialFailure(res, 409, "credential_already_exists", "此 API Key 已存在");
  }
  let encryptedApiKey: string;
  try {
    encryptedApiKey = encryptCredential(parsed.data.apiKey);
  } catch (error) {
    if (error instanceof Error && /not configured/i.test(error.message)) {
      return credentialFailure(res, 503, "credential_vault_unavailable", "Credential vault 暫時無法使用");
    }
    return credentialFailure(res, 500, "credential_encryption_failed", "Credential 加密失敗");
  }
  let row: NonNullable<ReturnType<typeof repos.aiProviders.findCredential>>;
  try {
    row = repos.aiProviders.createCredential({ ...parsed.data, providerConfigId: provider.id,
      evaluationAuthorizedAt: parsed.data.allowEvaluation ? new Date().toISOString() : null,
      evaluationAuthorizedByAdminId: parsed.data.allowEvaluation ? adminActorId(req) : null,
      encryptedApiKey, maskedApiKey: maskCredential(parsed.data.apiKey), keyFingerprint: fingerprint });
  } catch (error) {
    if (isUniqueCredentialStorageError(error)) {
      return credentialFailure(res, 409, "credential_already_exists", "此 Credential 已存在");
    }
    return credentialFailure(res, 500, "credential_storage_failed", "Credential 儲存失敗");
  }
  repos.aiProviders.audit("credential.created", "credential", row.id, { provider: provider.provider, status: row.status });
  res.status(201).json({ credential: publicCredential(row) });
});
app.put("/api/admin/ai-credentials/:credentialId", (req, res) => {
  const current = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!current) return fail(res, 404, "credential not found");
  const parsed = updateAiCredentialInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "invalid credential payload");
  let { apiKey, model, rpmLimit, tpmLimit, rpdLimit, resetTimezone, isDefaultModel, ...safePatch } = parsed.data;
  // Some older clients populated the write-only input with the displayed
  // mask. Treat that as "unchanged" so a mask can never overwrite a key.
  if (apiKey && isMaskedCredentialValue(apiKey, current.maskedApiKey)) apiKey = undefined;
  const provider = repos.aiProviders.findConfig(current.providerConfigId);
  if (safePatch.name && provider && repos.aiProviders.findCredentialByName(provider.id, safePatch.name, current.id)) {
    return fail(res, 409, "credential name already exists");
  }
  if (apiKey) {
    const fingerprint = credentialFingerprint(apiKey);
    const other = repos.aiProviders.findByFingerprint(fingerprint);
    if (other && other.id !== current.id) return fail(res, 409, "credential already exists");
    try {
      Object.assign(safePatch, { encryptedApiKey: encryptCredential(apiKey), maskedApiKey: maskCredential(apiKey), keyFingerprint: fingerprint });
    } catch {
      return fail(res, 503, "credential vault is not configured");
    }
  }
  const effectiveBillingMode = safePatch.billingMode ?? current.billingMode;
  const effectiveUsageScope = safePatch.usageScope ?? current.usageScope;
  const effectiveProductionAuthorized = safePatch.productionAuthorized ?? current.productionAuthorized;
  const policyFailure = credentialActivationFailure(
    res,
    provider?.provider ?? "unknown",
    effectiveBillingMode as ProviderBillingMode,
    effectiveUsageScope as StoredCredentialUsageScope,
    effectiveProductionAuthorized
  );
  if (policyFailure) return policyFailure;
  const status = safePatch.status;
  const patch: Parameters<typeof repos.aiProviders.updateCredential>[1] = {
    ...safePatch,
    ...(safePatch.allowEvaluation === true ? { evaluationAuthorizedAt: new Date().toISOString(), evaluationAuthorizedByAdminId: adminActorId(req) } : {}),
    ...(safePatch.allowEvaluation === false ? { evaluationAuthorizedAt: null, evaluationAuthorizedByAdminId: null } : {}),
    ...(status === "disabled" ? { disabledAt: new Date().toISOString() } : status ? { disabledAt: null } : {})
  };
  let row: ReturnType<typeof repos.aiProviders.updateCredential>;
  try {
    row = repos.aiProviders.updateCredential(current.id, patch);
    if (model !== undefined && model !== null) {
      if (!model.trim()) return credentialFailure(res, 422, "validation_error", "Credential 欄位格式不正確", {
        model: "Credential Model 不可空白；請至少保留一組預設模型"
      });
      if (isDefaultModel === false) return fail(res, 400, "Credential Model 必須同步代表預設模型");
      const existingQuota = repos.aiCredentialModelQuotas.findForCredential(current.id, model);
      const quotaPatch = {
        model,
        ...(rpmLimit !== undefined ? { rpmLimit } : {}),
        ...(tpmLimit !== undefined ? { tpmLimit } : {}),
        ...(rpdLimit !== undefined ? { rpdLimit } : {}),
        ...(resetTimezone !== undefined ? { resetTimezone } : {}),
        isDefault: true,
        enabled: true
      };
      if (existingQuota) repos.aiCredentialModelQuotas.update(existingQuota.id, quotaPatch);
      else repos.aiCredentialModelQuotas.create({ ...quotaPatch, credentialId: current.id });
      row = repos.aiProviders.findCredential(current.id) ?? row;
    }
  } catch {
    return fail(res, 409, "credential could not be updated");
  }
  repos.aiProviders.audit(apiKey ? "credential.replaced" : "credential.updated", "credential", current.id, { status: row?.status });
  res.json({ credential: row ? publicCredential(row) : null });
});
app.post("/api/admin/ai-credentials/:credentialId/enable", (req, res) => {
  const current = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!current) return fail(res, 404, "credential not found");
  const provider = repos.aiProviders.findConfig(current.providerConfigId);
  const policyFailure = credentialActivationFailure(
    res,
    provider?.provider ?? "unknown",
    current.billingMode as ProviderBillingMode,
    current.usageScope as StoredCredentialUsageScope,
    current.productionAuthorized
  );
  if (policyFailure) return policyFailure;
  const row = repos.aiProviders.updateCredential(String(req.params.credentialId), { status: "active", disabledAt: null });
  if (!row) return fail(res, 404, "credential not found");
  repos.aiProviders.audit("credential.enabled", "credential", row.id);
  res.json({ credential: publicCredential(row) });
});
app.post("/api/admin/ai-credentials/:credentialId/disable", (req, res) => {
  const row = repos.aiProviders.updateCredential(String(req.params.credentialId), { status: "disabled", disabledAt: new Date().toISOString() });
  if (!row) return fail(res, 404, "credential not found");
  repos.aiProviders.audit("credential.disabled", "credential", row.id);
  res.json({ credential: publicCredential(row) });
});
app.delete("/api/admin/ai-credentials/:credentialId", (req, res) => {
  const current = repos.aiProviders.findCredentialIncludingDeleted(String(req.params.credentialId));
  if (!current) return fail(res, 404, "credential not found");
  // DELETE is idempotent: a previously soft-deleted row is already in the
  // requested state and must not produce another audit event.
  if (current.deletedAt) return res.status(204).end();
  const deletedAt = new Date().toISOString();
  const wasLastActive = current.status === "active" && repos.aiProviders
    .listCredentials(current.providerConfigId)
    .filter((row) => row.status === "active").length === 1;
  repos.aiProviders.updateCredential(current.id, { deletedAt, status: "disabled", disabledAt: deletedAt });
  repos.aiProviders.audit("credential.deleted", "credential", current.id, { lastActiveCredential: wasLastActive });
  res.status(204).end();
});
app.post("/api/admin/ai-credentials/:credentialId/test", async (req, res) => {
  const started = Date.now();
  let upstreamRequestSent = false;
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  const safeTestResponse = (status: "success" | "failed", reason: string, endpointProfile: string | null) => ({
    status,
    reason,
    latencyMs: Date.now() - started,
    endpointProfile,
    upstreamRequestSent
  });
  if (!credential) {
    return res.status(404).json(safeTestResponse("failed", "local_validation_failed", null));
  }
  const provider = repos.aiProviders.findConfig(credential.providerConfigId);
  if (!provider) {
    return res.status(404).json(safeTestResponse("failed", "provider_instance_not_found", null));
  }
  const managedProvider = provider.provider as "openai" | "gemini" | "kimi" | "qwen" | "zai";
  const configuredEndpointProfile = credential.endpointProfile?.trim() || undefined;
  const endpointProfile = managedProvider === "gemini"
    ? configuredEndpointProfile ?? "gemini_native"
    : configuredEndpointProfile ?? null;
  if (managedProvider === "gemini" && configuredEndpointProfile && !["gemini_native", "gemini_openai_compatible"].includes(configuredEndpointProfile)) {
    const response = safeTestResponse("failed", "wrong_endpoint_profile", endpointProfile);
    repos.aiProviders.recordTest(credential.id, "failed", response.latencyMs);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, {
      providerConfigId: provider.id,
      providerSlug: provider.slug,
      result: "failed",
      validationReason: response.reason,
      endpointProfile: response.endpointProfile,
      latencyMs: response.latencyMs,
      upstreamRequestSent: response.upstreamRequestSent
    });
    return res.status(422).json(response);
  }
  try {
    // Decrypt only for a bounded local sanity check. The plaintext never
    // leaves this process and is not included in logs or response metadata.
    const apiKey = decryptCredential(credential.encryptedApiKey);
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
      const response = safeTestResponse("failed", "local_validation_failed", endpointProfile);
      repos.aiProviders.recordTest(credential.id, "failed", response.latencyMs);
      repos.aiProviders.audit("credential.tested", "credential", credential.id, {
        providerConfigId: provider.id,
        providerSlug: provider.slug,
        result: "failed",
        validationReason: response.reason,
        endpointProfile: response.endpointProfile,
        latencyMs: response.latencyMs,
        upstreamRequestSent: response.upstreamRequestSent
      });
      return res.status(422).json(response);
    }
  } catch {
    const response = safeTestResponse("failed", "local_validation_failed", endpointProfile);
    repos.aiProviders.recordTest(credential.id, "failed", response.latencyMs);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, {
      providerConfigId: provider.id,
      providerSlug: provider.slug,
      result: "failed",
      validationReason: response.reason,
      endpointProfile: response.endpointProfile,
      latencyMs: response.latencyMs,
      upstreamRequestSent: response.upstreamRequestSent
    });
    return res.status(422).json(response);
  }
  if (managedProvider === "qwen") {
    const endpoint = validateQwenEndpoint({
      baseUrl: credential.baseUrl ?? provider.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      region: credential.region ?? undefined,
      endpointProfile: credential.endpointProfile ?? undefined
    });
    if (!endpoint.ok) {
      const reason = endpoint.reason;
      const health = healthForCredentialVerification(reason);
      repos.aiProviders.updateCredential(credential.id, {
        providerHealth: health,
        ...(health === "access_denied" || health === "quota_exhausted"
          ? { status: "disabled", disabledAt: new Date().toISOString() }
          : {})
      });
      const response = safeTestResponse("failed", reason, endpointProfile);
      repos.aiProviders.recordTest(credential.id, response.status, response.latencyMs);
      repos.aiProviders.audit("credential.tested", "credential", credential.id, {
        providerConfigId: provider.id,
        providerSlug: provider.slug,
        result: response.status,
        validationReason: response.reason,
        endpointProfile: response.endpointProfile,
        latencyMs: response.latencyMs,
        upstreamRequestSent: response.upstreamRequestSent,
        region: credential.region
      });
      return res.status(422).json(response);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    // Uses the same sanitised adapter path as production; no upstream body is exposed.
    const adapter = new CredentialBackedProvider(
      managedProvider,
      repos,
      provider.model || defaultModelForManagedProvider(managedProvider),
      credential.id,
      "development_interactive",
      () => { upstreamRequestSent = true; }
    );
    await adapter.generate({ requestId: `credential_test_${randomUUID()}`, prompt: "Reply with OK.", maxOutputTokens: 8, signal: controller.signal });
    const response = safeTestResponse("success", "valid", endpointProfile);
    repos.aiProviders.recordTest(credential.id, response.status, response.latencyMs);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, {
      providerConfigId: provider.id,
      providerSlug: provider.slug,
      result: response.status,
      validationReason: response.reason,
      endpointProfile: response.endpointProfile,
      latencyMs: response.latencyMs,
      upstreamRequestSent: response.upstreamRequestSent,
      region: credential.region
    });
    res.json(response);
  } catch (error) {
    const status = error instanceof AiGatewayError ? error.upstreamStatus : undefined;
    const reason = controller.signal.aborted
      ? "provider_timeout"
      : !upstreamRequestSent
        ? error instanceof AiGatewayError && error.fallbackReason === "quota_exhausted"
          ? "quota_exhausted"
          : "local_validation_failed"
        : classifyCredentialVerification({
            status,
            apiKeyPresent: true,
            quotaExhausted: status === 429 && error instanceof AiGatewayError && error.fallbackReason === "quota_exhausted"
          });
    const health = healthForCredentialVerification(
      reason === "provider_timeout"
        ? "provider_unavailable"
        : reason === "local_validation_failed"
          ? "unknown"
          : reason
    );
    repos.aiProviders.updateCredential(credential.id, {
      providerHealth: health,
      ...(health === "access_denied" || health === "quota_exhausted"
        ? { status: "disabled", disabledAt: new Date().toISOString() }
        : {})
    });
    const response = safeTestResponse("failed", reason, endpointProfile);
    repos.aiProviders.recordTest(credential.id, response.status, response.latencyMs);
    repos.aiProviders.audit("credential.tested", "credential", credential.id, {
      providerConfigId: provider.id,
      providerSlug: provider.slug,
      result: response.status,
      validationReason: response.reason,
      httpStatus: status,
      endpointProfile: response.endpointProfile,
      latencyMs: response.latencyMs,
      upstreamRequestSent: response.upstreamRequestSent,
      region: credential.region,
      health
    });
    const responseStatus = reason === "rate_limited" || reason === "quota_exhausted" ? 429 : 503;
    res.status(responseStatus).json(response);
  } finally {
    clearTimeout(timeout);
  }
});

// ---- AI Analytics (admin) ------------------------------------------------
// Read-side aggregations over ai_request_logs / ai_usage_logs / ai_daily_usage.
// All admin analytics routes are gated by requireAdminAccess when a token is
// configured. Responses never contain raw IPs, API keys, or system prompts.
app.get("/api/admin/ai-analytics/summary", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const date = typeof req.query.date === "string" ? req.query.date : todayTaipei();
  if (!isValidDateOnly(date)) return fail(res, 400, "date must be a valid YYYY-MM-DD date");
  res.json(analytics.summary(date));
});

app.get("/api/admin/ai-analytics/daily", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.daily(range.fromIso, range.toIso));
});

app.get("/api/admin/ai-analytics/providers", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.providers(range.fromIso, range.toIso));
});

app.get("/api/admin/ai-analytics/subjects", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.subjects(range.fromIso, range.toIso));
});

app.get("/api/admin/ai-requests", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1) return fail(res, 400, "page must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail(res, 400, "limit must be an integer between 1 and 200");
  }
  const sort = req.query.sort === undefined ? "newest" : req.query.sort;
  if (sort !== "newest" && sort !== "oldest" && sort !== "latency") {
    return fail(res, 400, "sort is not supported");
  }
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const requestSource = typeof req.query.requestSource === "string" ? req.query.requestSource : undefined;
  if (provider && !["mock", "gemini", "openai", "kimi", "qwen", "zai"].includes(provider)) {
    return fail(res, 400, "provider is not supported");
  }
  if (subject && !["math", "science", "programming", "language", "humanities", "general", "unknown"].includes(subject)) {
    return fail(res, 400, "subject is not supported");
  }
  if (status && !["pending", "success", "failed", "fallback", "rejected", "timeout"].includes(status)) {
    return fail(res, 400, "status is not supported");
  }
  if (requestSource && !["guest", "student", "book_qa", "admin", "internal"].includes(requestSource)) {
    return fail(res, 400, "requestSource is not supported");
  }
  const model = typeof req.query.model === "string" ? req.query.model.trim() : undefined;
  if (model && (model.length === 0 || model.length > 200)) return fail(res, 400, "model is invalid");
  const result = analytics.listRequests({
    from: range.fromIso,
    to: range.toIso,
    provider,
    model,
    subject,
    status,
    requestSource,
    page,
    limit,
    sort
  });
  res.json(result);
});

app.get("/api/admin/ai-requests/:requestId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const detail = analytics.requestDetail(req.params.requestId);
  if (!detail) return fail(res, 404, "request not found");
  res.json(detail);
});

// Full Q&A + token/cost detail (spec §3.2, §3.3). The full questionText and
// answerText are returned ONLY here; the list endpoint exposes previews.
// Output goes through the typed safe mapper in analytics.usageDetail().
app.get("/api/admin/ai-usage/:requestId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const detail = analytics.usageDetail(req.params.requestId);
  if (!detail) return fail(res, 404, "usage not found");
  res.json(detail);
});

// ---- Controlled Live Evaluation ------------------------------------------
// Live remains disabled until an administrator stores an explicit allowlist,
// enables the feature, enables a dedicated Evaluation Pool, and completes a
// short-lived preflight/confirmation handshake.
app.get("/api/admin/ai-evaluations/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ settings: liveEvaluationService.getSettings() });
});

app.put("/api/admin/ai-evaluations/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const allowed = ["enabled", "evaluationPoolId", "allowedDatasetIds", "allowedLogicalModelIds", "allowedProviderIds", "maxCasesPerRun", "maxTokensPerRun", "maxTokensPerDay", "maxConcurrentRuns", "requireDryRun", "requireExplicitConfirmation"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ error: "unsupported live setting", code: "invalid_live_settings" });
  const arrays = [body.allowedDatasetIds, body.allowedLogicalModelIds, body.allowedProviderIds];
  if (arrays.some((value) => !Array.isArray(value) || value.some((item) => typeof item !== "string"))) return res.status(400).json({ error: "allowlist fields must be string arrays", code: "invalid_live_settings" });
  try {
    const settings = liveEvaluationService.saveSettings({
      enabled: body.enabled === true,
      evaluationPoolId: typeof body.evaluationPoolId === "string" ? body.evaluationPoolId : undefined,
      allowedDatasetIds: body.allowedDatasetIds as string[],
      allowedLogicalModelIds: body.allowedLogicalModelIds as string[],
      allowedProviderIds: body.allowedProviderIds as string[],
      maxCasesPerRun: Number(body.maxCasesPerRun), maxTokensPerRun: Number(body.maxTokensPerRun), maxTokensPerDay: Number(body.maxTokensPerDay), maxConcurrentRuns: Number(body.maxConcurrentRuns),
      requireDryRun: body.requireDryRun !== false, requireExplicitConfirmation: body.requireExplicitConfirmation !== false,
      updatedAt: new Date().toISOString()
    }, adminActorId(req));
    res.json({ settings });
  } catch (error) { liveEvaluationError(res, error); }
});

app.post("/api/admin/ai-evaluations/live-preflight", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const logicalModelIds = Array.isArray(body.logicalModelIds) && body.logicalModelIds.every((value) => typeof value === "string") ? body.logicalModelIds as string[] : [];
  try {
    const result = liveEvaluationService.preflight({ adminId: adminActorId(req), datasetId: typeof body.datasetId === "string" ? body.datasetId : "", maxCases: Number(body.maxCases), maxTokenBudget: Number(body.maxTokenBudget), logicalModelIds });
    res.status(result.allowed ? 200 : 409).json(result);
  } catch (error) { liveEvaluationError(res, error); }
});

app.get("/api/admin/ai-evaluations/live-readiness", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json(liveEvaluationService.readiness());
});

app.get("/api/admin/ai-pilot/production-readiness", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json(pilotService.productionReadiness());
});

app.post("/api/admin/ai-pilot/readiness-review", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(pilotService.review(req.body as Record<string, unknown>, adminActorId(req))); }
  catch (error) { pilotServiceError(res, error); }
});

app.get("/api/admin/ai-pilot/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ settings: pilotService.settings() });
});

app.put("/api/admin/ai-pilot/settings", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const current = pilotService.settings();
    const categories = Array.isArray(body.allowedTaskCategories) && body.allowedTaskCategories.every((value) => typeof value === "string")
      ? body.allowedTaskCategories as Array<"programming" | "mathematics" | "knowledge"> : current.allowedTaskCategories;
    const stopPolicy = body.stopPolicy && typeof body.stopPolicy === "object" && !Array.isArray(body.stopPolicy) ? body.stopPolicy as typeof current.stopPolicy : current.stopPolicy;
    const settings = pilotService.saveSettings({
      enabled: body.enabled === true,
      trafficPercentage: body.trafficPercentage === undefined ? current.trafficPercentage : Number(body.trafficPercentage),
      allowedTaskCategories: categories,
      allowVerification: body.allowVerification === undefined ? current.allowVerification : body.allowVerification === true,
      allowAdjudication: body.allowAdjudication === undefined ? current.allowAdjudication : body.allowAdjudication === true,
      maxModelCallsPerRequest: body.maxModelCallsPerRequest === undefined ? current.maxModelCallsPerRequest : Number(body.maxModelCallsPerRequest),
      pilotVersion: typeof body.pilotVersion === "string" ? body.pilotVersion : current.pilotVersion,
      stopPolicy
    }, adminActorId(req));
    res.json({ settings });
  } catch (error) { pilotServiceError(res, error); }
});

app.post("/api/admin/ai-pilot/disable", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ settings: pilotService.disable("admin_kill_switch", adminActorId(req)) });
});

app.get("/api/admin/ai-pilot/metrics", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ metrics: pilotService.metrics() });
});

app.post("/api/admin/ai-evaluations/:id/cancel", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(liveEvaluationService.cancel(req.params.id)); }
  catch (error) { liveEvaluationError(res, error); }
});

// ---- Phase 4D evaluation governance -------------------------------------
// These routes govern only offline Fixture/Mock schedules and safe summaries.
// The scheduler is disabled by default and has no Live execution branch.
app.get("/api/admin/ai-evaluations/retention", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ policy: evaluationGovernanceService.getSettings().retention });
});

app.put("/api/admin/ai-evaluations/retention", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const policy = body as unknown as Parameters<typeof evaluationGovernanceService.saveSettings>[0]["retention"];
    const current = evaluationGovernanceService.getSettings();
    const saved = evaluationGovernanceService.saveSettings({ retention: policy, regressionAlert: current.regressionAlert, budgetAlert: current.budgetAlert, schedulerEnabled: current.schedulerEnabled }, adminActorId(req));
    repos.aiProviders.audit("evaluation.retention.policy_updated", "ai_evaluation_governance", "default", { enabled: saved.retention.enabled, maxRunsPerDatasetMode: saved.retention.maxRunsPerDatasetMode });
    res.json({ policy: saved.retention });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluations/governance", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json(evaluationGovernanceService.getSettings());
});

app.put("/api/admin/ai-evaluations/governance", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "schedulerEnabled") || typeof body.schedulerEnabled !== "boolean") return res.status(400).json({ error: "schedulerEnabled is required", code: "invalid_governance_settings" });
  try {
    const current = evaluationGovernanceService.getSettings();
    res.json(evaluationGovernanceService.saveSettings({ retention: current.retention, regressionAlert: current.regressionAlert, budgetAlert: current.budgetAlert, schedulerEnabled: body.schedulerEnabled }, adminActorId(req)));
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluations/retention/preview", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(evaluationGovernanceService.retentionPreview(adminActorId(req))); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluations/retention/run", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (typeof body.previewId !== "string" || typeof body.confirmationToken !== "string") return res.status(400).json({ error: "previewId and confirmationToken are required", code: "invalid_retention_request" });
  try { res.json(evaluationGovernanceService.executeRetention({ previewId: body.previewId, confirmationToken: body.confirmationToken }, adminActorId(req))); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-schedules", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ schedulerEnabled: evaluationGovernanceService.getSettings().schedulerEnabled, schedules: evaluationGovernanceService.listSchedules() });
});

app.post("/api/admin/ai-evaluation-schedules", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  try {
    const row = evaluationGovernanceService.createSchedule({ enabled: body.enabled === true, datasetId: String(body.datasetId ?? ""), datasetVersion: Number(body.datasetVersion), executionMode: body.executionMode as "fixture" | "mock_orchestrator", cadence: body.cadence as "daily" | "weekly", scheduledTime: String(body.scheduledTime ?? ""), timezone: String(body.timezone ?? ""), baselinePolicy: body.baselinePolicy as "latest_comparable" | "fixed", fixedBaselineRunId: typeof body.fixedBaselineRunId === "string" ? body.fixedBaselineRunId : undefined }, adminActorId(req));
    res.status(201).json({ schedule: row });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.put("/api/admin/ai-evaluation-schedules/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  try {
    const allowed = ["enabled", "datasetId", "datasetVersion", "executionMode", "cadence", "scheduledTime", "timezone", "baselinePolicy", "fixedBaselineRunId"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return res.status(400).json({ error: "unsupported schedule field", code: "invalid_schedule" });
    const row = evaluationGovernanceService.updateSchedule(req.params.id, body as never, adminActorId(req));
    res.json({ schedule: row });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.delete("/api/admin/ai-evaluation-schedules/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json(evaluationGovernanceService.deleteSchedule(req.params.id)); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.post("/api/admin/ai-evaluation-schedules/run-due", async (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try { res.json({ results: await evaluationGovernanceService.runDue(new Date(), adminActorId(req)) }); }
  catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-alert-policy", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ policy: evaluationGovernanceService.getSettings().regressionAlert, budgetPolicy: evaluationGovernanceService.getSettings().budgetAlert, schedulerEnabled: evaluationGovernanceService.getSettings().schedulerEnabled });
});

app.put("/api/admin/ai-evaluation-alert-policy", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const current = evaluationGovernanceService.getSettings();
    const policy = body as unknown as Parameters<typeof evaluationGovernanceService.saveSettings>[0]["regressionAlert"];
    const saved = evaluationGovernanceService.saveSettings({ retention: current.retention, regressionAlert: policy, budgetAlert: current.budgetAlert, schedulerEnabled: current.schedulerEnabled }, adminActorId(req));
    res.json({ policy: saved.regressionAlert, budgetPolicy: saved.budgetAlert });
  } catch (error) { evaluationGovernanceError(res, error); }
});

app.get("/api/admin/ai-evaluation-alerts", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const status = req.query.status === "open" || req.query.status === "acknowledged" || req.query.status === "resolved" ? req.query.status : undefined;
  res.json({ alerts: evaluationGovernanceService.listAlerts(status) });
});

app.post("/api/admin/ai-evaluation-alerts/:id/acknowledge", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const alert = evaluationGovernanceService.acknowledgeAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: "alert not found", code: "alert_not_found" });
  repos.aiProviders.audit("evaluation.alert.acknowledged", "ai_evaluation_alert", req.params.id, { status: alert.status });
  res.json({ alert });
});

app.post("/api/admin/ai-evaluation-alerts/:id/resolve", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const alert = evaluationGovernanceService.resolveAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: "alert not found", code: "alert_not_found" });
  repos.aiProviders.audit("evaluation.alert.resolved", "ai_evaluation_alert", req.params.id, { status: alert.status });
  res.json({ alert });
});

// ---- Offline AI evaluation quality centre -------------------------------
// Dataset and fixture selection is server-owned. These routes never accept a
// filesystem path, prompt, provider credential, API key, or shell command.
app.get("/api/admin/ai-evaluations", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  if (typeof req.query.executionMode === "string" && !["fixture", "mock_orchestrator", "live"].includes(req.query.executionMode)) return fail(res, 400, "executionMode is not supported");
  if (typeof req.query.status === "string" && !["pending_confirmation", "running", "completed", "failed", "cancelled", "budget_exhausted"].includes(req.query.status)) return fail(res, 400, "status is not supported");
  if (req.query.sort !== undefined && req.query.sort !== "newest") return fail(res, 400, "sort is not supported");
  if (typeof req.query.datasetId === "string" && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(req.query.datasetId)) return fail(res, 400, "datasetId is invalid");
  const mode = typeof req.query.executionMode === "string" ? req.query.executionMode as "fixture" | "mock_orchestrator" | "live" : undefined;
  const status = typeof req.query.status === "string" ? req.query.status as "pending_confirmation" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted" : undefined;
  const datasetId = typeof req.query.datasetId === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(req.query.datasetId)
    ? req.query.datasetId : undefined;
  const parseNumber = (value: unknown, fallback: number) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
    return Number(value);
  };
  const limit = Math.min(100, Math.max(1, parseNumber(req.query.limit, 50)));
  const offset = Math.max(0, parseNumber(req.query.offset, 0));
  if (typeof req.query.dateFrom === "string" && !/^\d{4}-\d{2}-\d{2}/.test(req.query.dateFrom)) return fail(res, 400, "dateFrom is invalid");
  if (typeof req.query.dateTo === "string" && !/^\d{4}-\d{2}-\d{2}/.test(req.query.dateTo)) return fail(res, 400, "dateTo is invalid");
  try {
    const page = evaluationService.list({ datasetId, executionMode: mode, status, dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined, dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined, limit, offset });
    res.json({ runs: page.rows.map(publicEvaluationRun), total: page.total, limit: page.limit, offset: page.offset });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.get("/api/admin/ai-evaluations/:id/report", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const format = req.query.format === "markdown" ? "markdown" : req.query.format === "json" ? "json" : undefined;
  if (!format) return res.status(400).json({ error: "report format must be json or markdown", code: "invalid_report_format" });
  try {
    const content = evaluationService.report(req.params.id, format);
    repos.aiProviders.audit("evaluation.report.downloaded", "ai_evaluation_run", req.params.id, { format });
    const filename = `ai-evaluation-${req.params.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format === "json" ? "json" : "md"}`;
    res.type(format === "json" ? "application/json" : "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    evaluationError(res, error);
  }
});

app.get("/api/admin/ai-evaluations/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  try {
    const detail = evaluationService.detail(req.params.id);
    res.json({ run: publicEvaluationRun(detail.run), metrics: detail.metrics, issues: detail.issues, regression: detail.regression });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.post("/api/admin/ai-evaluations/run", async (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const body = req.body as Record<string, unknown>;
  if (body.executionMode === "live") {
    const liveAllowed = ["datasetId", "executionMode", "maxCases", "maxTokenBudget", "logicalModelIds", "dryRunId", "confirmationToken", "baselineRunId"];
    if (Object.keys(body).some((key) => !liveAllowed.includes(key))) return res.status(400).json({ error: "invalid live evaluation request", code: "invalid_live_evaluation_request" });
    const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
    const logicalModelIds = Array.isArray(body.logicalModelIds) && body.logicalModelIds.every((value) => typeof value === "string") ? body.logicalModelIds as string[] : [];
    try {
      const result = await liveEvaluationService.start({ adminId: adminActorId(req), datasetId: typeof body.datasetId === "string" ? body.datasetId : "", maxCases: Number(body.maxCases), maxTokenBudget: Number(body.maxTokenBudget), logicalModelIds, dryRunId: typeof body.dryRunId === "string" ? body.dryRunId : "", confirmationToken: typeof body.confirmationToken === "string" ? body.confirmationToken : "", baselineRunId: typeof body.baselineRunId === "string" ? body.baselineRunId : undefined, idempotencyKey });
      return res.status(result.reused ? 200 : 201).json({ run: publicEvaluationRun(result.run), report: result.report, reused: result.reused, cancelled: result.cancelled ?? false });
    } catch (error) { return liveEvaluationError(res, error); }
  }
  if (Object.keys(body).some((key) => !["datasetId", "executionMode", "baselineRunId"].includes(key))) {
    return res.status(400).json({ error: "only datasetId, executionMode and baselineRunId are accepted", code: "invalid_evaluation_request" });
  }
  const datasetId = typeof body.datasetId === "string" ? body.datasetId : "";
  const executionMode = body.executionMode;
  const baselineRunId = typeof body.baselineRunId === "string" ? body.baselineRunId : undefined;
  const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(idempotencyKey)) return res.status(400).json({ error: "Idempotency-Key is required", code: "missing_idempotency_key" });
  if (typeof executionMode !== "string" || !["fixture", "mock_orchestrator", "live"].includes(executionMode)) return res.status(400).json({ error: "executionMode is invalid", code: "invalid_execution_mode" });
  try {
    const result = await evaluationService.start({ datasetId, executionMode: executionMode as "fixture" | "mock_orchestrator" | "live", baselineRunId, idempotencyKey });
    if (executionMode !== "live" && !result.reused) evaluationGovernanceService.evaluateRunAlerts(result.run.id);
    res.status(result.reused ? 200 : 201).json({ run: publicEvaluationRun(result.run), reused: result.reused });
  } catch (error) {
    evaluationError(res, error);
  }
});

app.delete("/api/admin/ai-evaluations/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  if (req.header("x-confirm-delete") !== "true") return res.status(400).json({ error: "delete confirmation required", code: "delete_confirmation_required" });
  try {
    const result = evaluationService.delete(req.params.id);
    res.json(result);
  } catch (error) {
    evaluationError(res, error);
  }
});

app.get("/api/admin/ai-budget-policies", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ policies: repos.aiBudgetPolicies.list() });
});

app.put("/api/admin/ai-budget-policies/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = updateAiBudgetPolicyInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const updated = repos.aiBudgetPolicies.update(req.params.id, parsed.data);
  if (!updated) return fail(res, 404, "budget policy not found");
  res.json({ policy: updated });
});

app.post("/api/admin/ai-budget-policies", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = createAiBudgetPolicyInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const policy = repos.aiBudgetPolicies.upsertByScope(parsed.data);
  res.status(201).json({ policy });
});

// ---- Token Pool management (spec §6) --------------------------------------
// All routes are admin-only (requireAdminAccess) and audit-logged. Pool and
// model-limit mutations validate that newDailyLimit >= used + reserved so an
// admin can never lower a cap below current in-flight usage.

app.get("/api/admin/ai-token-pools", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const pools = repos.aiTokenPools.list().map(publicTokenPool);
  res.json({ pools });
});

app.post("/api/admin/ai-token-pools", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = createAiTokenPoolInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const existing = repos.aiTokenPools.findByType(parsed.data.poolType);
  if (existing) return fail(res, 409, "token pool type already exists");
  const created = repos.aiTokenPools.create({
    name: parsed.data.name,
    poolType: parsed.data.poolType,
    timezone: parsed.data.timezone,
    dailyLimit: parsed.data.dailyLimit,
    warningThreshold: parsed.data.warningThreshold,
    throttleThreshold: parsed.data.throttleThreshold,
    criticalThreshold: parsed.data.criticalThreshold,
    resetAt: new Date(Date.now() + 86_400_000).toISOString(),
    enabled: parsed.data.enabled
  });
  repos.aiProviders.audit("token_pool.created", "token_pool", created.id, { poolType: created.poolType });
  res.status(201).json({ pool: publicTokenPool(created) });
});

app.patch("/api/admin/ai-token-pools/:id", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const current = repos.aiTokenPools.findById(req.params.id);
  if (!current) return fail(res, 404, "token pool not found");
  const parsed = updateAiTokenPoolInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  // Validate: newDailyLimit must cover current committed usage.
  if (parsed.data.dailyLimit !== undefined) {
    const committed = current.usedTokens + current.reservedTokens;
    if (parsed.data.dailyLimit < committed) {
      res.status(409).json({ error: "daily_limit_below_current_usage", code: "daily_limit_below_current_usage" });
      return;
    }
  }
  // Validate: thresholds strictly increasing when all three provided.
  const w = parsed.data.warningThreshold ?? current.warningThreshold;
  const t = parsed.data.throttleThreshold ?? current.throttleThreshold;
  const c = parsed.data.criticalThreshold ?? current.criticalThreshold;
  if (!(w < t && t < c)) {
    res.status(409).json({ error: "thresholds must be strictly increasing", code: "invalid_thresholds" });
    return;
  }
  const updated = repos.aiTokenPools.update(req.params.id, parsed.data);
  if (!updated) return fail(res, 404, "token pool not found");
  repos.aiProviders.audit("token_pool.updated", "token_pool", updated.id, { poolType: updated.poolType });
  res.json({ pool: publicTokenPool(updated) });
});

// ---- Logical Model Registry ------------------------------------------------

app.get("/api/admin/ai-logical-models", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ logicalModels: repos.aiLogicalModels.list() });
});

app.post("/api/admin/ai-logical-models", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = upsertAiLogicalModelInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  if (parsed.data.providerConfigId) {
    const provider = repos.aiProviders.findConfig(parsed.data.providerConfigId);
    if (!provider || provider.provider !== parsed.data.providerId) return fail(res, 422, "logical model provider instance does not match adapter type");
  }
  const row = repos.aiLogicalModels.upsert(parsed.data);
  repos.aiProviders.audit("logical_model.upserted", "logical_model", row.id, { logicalModelId: row.logicalModelId });
  res.status(201).json({ logicalModel: row });
});

app.patch("/api/admin/ai-logical-models/:logicalModelId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = updateAiLogicalModelInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  if (parsed.data.providerConfigId) {
    const currentProvider = repos.aiLogicalModels.findByLogicalId(req.params.logicalModelId);
    const provider = repos.aiProviders.findConfig(parsed.data.providerConfigId);
    const adapter = parsed.data.providerId ?? currentProvider?.providerId;
    if (!provider || provider.provider !== adapter) return fail(res, 422, "logical model provider instance does not match adapter type");
  }
  const updated = repos.aiLogicalModels.update(req.params.logicalModelId, parsed.data);
  if (!updated) return fail(res, 404, "logical model not found");
  repos.aiProviders.audit("logical_model.updated", "logical_model", updated.id, { logicalModelId: updated.logicalModelId });
  res.json({ logicalModel: updated });
});

// ---- Model Daily Limits ----------------------------------------------------

app.get("/api/admin/ai-model-limits", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ modelLimits: repos.aiModelDailyLimits.list() });
});

app.patch("/api/admin/ai-model-limits/:logicalModelId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const parsed = updateAiModelDailyLimitInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const current = repos.aiModelDailyLimits.findByLogicalModel(req.params.logicalModelId);
  if (!current) return fail(res, 404, "model daily limit not found");
  // Validate: newDailyLimit must cover current committed usage.
  if (parsed.data.dailyLimit !== undefined) {
    const committed = current.usedTokens + current.reservedTokens;
    if (parsed.data.dailyLimit < committed) {
      res.status(409).json({ error: "daily_limit_below_current_usage", code: "daily_limit_below_current_usage" });
      return;
    }
  }
  // Validate: fallbackLogicalModelId must not be self.
  if (parsed.data.fallbackLogicalModelId !== undefined && parsed.data.fallbackLogicalModelId !== null) {
    if (parsed.data.fallbackLogicalModelId === req.params.logicalModelId) {
      res.status(409).json({ error: "fallback_logical_model_cannot_be_self", code: "fallback_cycle_detected" });
      return;
    }
    // Detect cycles up to 10 hops.
    const target = repos.aiModelDailyLimits.findByLogicalModel(parsed.data.fallbackLogicalModelId);
    if (target) {
      let cursor: string | null = parsed.data.fallbackLogicalModelId;
      for (let i = 0; i < 10 && cursor; i += 1) {
        const row = repos.aiModelDailyLimits.findByLogicalModel(cursor);
        cursor = row?.fallbackLogicalModelId ?? null;
        if (cursor === req.params.logicalModelId) {
          res.status(409).json({ error: "fallback cycle detected", code: "fallback_cycle_detected" });
          return;
        }
      }
    }
  }
  const updated = repos.aiModelDailyLimits.update(req.params.logicalModelId, parsed.data);
  if (!updated) return fail(res, 404, "model daily limit not found");
  repos.aiProviders.audit("model_limit.updated", "model_daily_limit", updated.id, { logicalModelId: updated.logicalModelId });
  res.json({ modelLimit: updated });
});

// ---- Token Pool usage (today) ---------------------------------------------

app.get("/api/admin/ai-token-usage/today", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const pools = repos.aiTokenPools.list().map((pool) => {
    const modelLimits = repos.aiModelDailyLimits.findByPool(pool.id);
    const modelHardCapsTotal = modelLimits.reduce((sum, m) => sum + m.dailyLimit, 0);
    return {
      ...publicTokenPool(pool),
      unallocatedCapacity: Math.max(0, pool.dailyLimit - modelHardCapsTotal)
    };
  });
  const models = repos.aiModelDailyLimits.list().map((m) => {
    const committed = m.usedTokens + m.reservedTokens;
    return {
      logicalModelId: m.logicalModelId,
      poolId: m.poolId,
      dailyLimit: m.dailyLimit,
      usedTokens: m.usedTokens,
      reservedTokens: m.reservedTokens,
      committedTokens: committed,
      remaining: Math.max(0, m.dailyLimit - committed),
      utilizationRatio: m.dailyLimit > 0 ? committed / m.dailyLimit : 0,
      priority: m.priority,
      fallbackLogicalModelId: m.fallbackLogicalModelId,
      enabled: m.enabled,
      allowSecondModelVerification: m.allowSecondModelVerification
    };
  });
  res.json({ date: todayTaipei(), pools, models });
});

app.get("/api/admin/ai-token-usage/models", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  res.json({ models: repos.aiModelDailyLimits.list() });
});

// ---- OpenAI Credential daily quota (per-key independent daily ledger) ----
// Lists ALL OpenAI credentials across every provider='openai' config (not just
// the default/router config) with their daily limit + today's usage. Non-OpenAI
// credentials never appear here. Pool summary is an aggregate only.
app.get("/api/admin/ai-quota-center/openai-credentials", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const openAi = repos.aiCredentialDailyUsage.listOpenAiCredentialIds();
  const credentialIds = openAi.map((row) => row.credentialId);
  const usageByCred = new Map(
    repos.aiCredentialDailyUsage.listTodayForCredentials(credentialIds).map((u) => [u.credentialId, u])
  );
  const credentials = openAi.map((row) => {
    const credential = repos.aiProviders.findCredential(row.credentialId);
    if (!credential) return null;
    const config = repos.aiProviders.findConfig(row.providerConfigId);
    const limit = repos.aiCredentialDailyUsage.findLimit(row.credentialId);
    const usage = usageByCred.get(row.credentialId);
    const usedTokens = usage?.usedTokens ?? 0;
    const reservedTokens = usage?.reservedTokens ?? 0;
    const dailyTokenLimit = limit?.dailyTokenLimit ?? null;
    const limitEnabled = limit?.enabled ?? false;
    return {
      credentialId: credential.id,
      instanceName: config?.displayName ?? config?.slug ?? null,
      name: credential.name,
      maskedApiKey: credential.maskedApiKey,
      status: credential.status,
      cooldownUntil: credential.cooldownUntil,
      dailyTokenLimit,
      dailyCostLimitMicroUsd: limit?.dailyCostLimitMicroUsd ?? null,
      timezone: limit?.timezone ?? "Asia/Taipei",
      limitEnabled,
      usedTokens,
      reservedTokens,
      remainingTokens: dailyTokenLimit !== null ? Math.max(0, dailyTokenLimit - usedTokens - reservedTokens) : null,
      utilizationRatio: dailyTokenLimit !== null && dailyTokenLimit > 0 ? (usedTokens + reservedTokens) / dailyTokenLimit : 0,
      requestCount: usage?.requestCount ?? 0,
      actualCostMicroUsd: usage?.actualCostMicroUsd ?? 0,
      costSource: usage?.costSource ?? "unconfigured",
      providerModel: usage?.providerModel ?? null,
      resetAt: usage?.resetAt ?? limit?.resetAt ?? null,
      lastUsedAt: usage?.lastUsedAt ?? null
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  const poolSummary = {
    label: "OpenAI 金鑰彙總",
    credentialCount: credentials.length,
    usedTokens: credentials.reduce((sum, c) => sum + c.usedTokens, 0),
    reservedTokens: credentials.reduce((sum, c) => sum + c.reservedTokens, 0),
    requestCount: credentials.reduce((sum, c) => sum + c.requestCount, 0),
    actualCostMicroUsd: credentials.reduce((sum, c) => sum + c.actualCostMicroUsd, 0),
    isAggregate: true
  };
  res.json({ date: todayTaipei(), credentials, poolSummary });
});

app.get("/api/admin/ai-quota-center/openai-credentials/:credentialId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  const config = repos.aiProviders.findConfig(credential.providerConfigId);
  if (config?.provider !== "openai") return fail(res, 400, "OPENAI_CREDENTIAL_REQUIRED");
  const limit = repos.aiCredentialDailyUsage.findLimit(credential.id);
  const usageRows = repos.aiCredentialDailyUsage.listTodayForCredentials([credential.id]);
  const usage = usageRows[0];
  const reservation = repos.aiCredentialDailyUsage.latestReservation(credential.id);
  res.json({
    credentialId: credential.id,
    name: credential.name,
    maskedApiKey: credential.maskedApiKey,
    limit,
    usage: usage ?? null,
    latestReservation: reservation ?? null
  });
});

app.get("/api/admin/ai-quota-center/openai-credentials/:credentialId/trend", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  const config = repos.aiProviders.findConfig(credential.providerConfigId);
  if (config?.provider !== "openai") return fail(res, 400, "OPENAI_CREDENTIAL_REQUIRED");
  const from = typeof req.query.from === "string" ? req.query.from : "1970-01-01";
  const to = typeof req.query.to === "string" ? req.query.to : todayTaipei();
  res.json({ history: repos.aiCredentialDailyUsage.listHistory(credential.id, from, to) });
});

app.put("/api/admin/ai-quota-center/openai-credentials/:credentialId/daily-limit", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const credential = repos.aiProviders.findCredential(String(req.params.credentialId));
  if (!credential) return fail(res, 404, "credential not found");
  const config = repos.aiProviders.findConfig(credential.providerConfigId);
  if (config?.provider !== "openai") return fail(res, 400, "OPENAI_CREDENTIAL_REQUIRED");
  const body = req.body ?? {};
  const patch: {
    dailyTokenLimit?: number | null;
    dailyCostLimitMicroUsd?: number | null;
    timezone?: string;
    warningThreshold?: number;
    enabled?: boolean;
  } = {};
  if (body.dailyTokenLimit !== undefined) {
    const value = body.dailyTokenLimit;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      return fail(res, 400, "INVALID_DAILY_LIMIT");
    }
    patch.dailyTokenLimit = value;
  }
  if (body.dailyCostLimitMicroUsd !== undefined) {
    const value = body.dailyCostLimitMicroUsd;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      return fail(res, 400, "INVALID_DAILY_LIMIT");
    }
    patch.dailyCostLimitMicroUsd = value;
  }
  if (body.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone }).format();
      patch.timezone = body.timezone;
    } catch {
      return fail(res, 400, "INVALID_TIMEZONE");
    }
  }
  if (body.warningThreshold !== undefined) {
    if (typeof body.warningThreshold !== "number" || body.warningThreshold < 0 || body.warningThreshold > 100) {
      return fail(res, 400, "INVALID_DAILY_LIMIT");
    }
    patch.warningThreshold = body.warningThreshold;
  }
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  const limit = repos.aiCredentialDailyUsage.updateLimit(credential.id, patch);
  repos.aiProviders.audit("credential_daily_limit_update", "provider", credential.id, {
    credentialId: credential.id,
    ...patch
  });
  res.json({ limit });
});

/** Public-facing token pool shape (strips nothing sensitive; pools have no secrets). */
function publicTokenPool(pool: { id: string; name: string; poolType: string; timezone: string; dailyLimit: number; usedTokens: number; reservedTokens: number; warningThreshold: number; throttleThreshold: number; criticalThreshold: number; resetAt: string; enabled: boolean }) {
  const committed = pool.usedTokens + pool.reservedTokens;
  return {
    ...pool,
    committedTokens: committed,
    remaining: Math.max(0, pool.dailyLimit - committed),
    utilizationRatio: pool.dailyLimit > 0 ? committed / pool.dailyLimit : 0
  };
}

// ---- Appearance settings -------------------------------------------------
// Public read (admin + student); admin-only update. Missing settings fall back
// to defaults so the UI never blanks out.
app.get("/api/appearance-settings", (_req, res) => {
  res.json({ settings: loadAppearance() });
});

app.put("/api/admin/appearance-settings", (req, res) => {
  const parsed = appearanceSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const merged = appearanceSettingsSchema.parse({ ...loadAppearance(), ...parsed.data });
  repos.settings.set(APPEARANCE_KEY, JSON.stringify(merged));
  res.json({ settings: merged });
});

app.post("/api/admin/appearance-settings/upload", appearanceUpload.single("file"), (req, res) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "image is required (png/jpg/jpeg/webp/svg, <=2MB)");
  res.status(201).json({ url: `/api/uploads/appearance/${file.filename}` });
});

// Do not let Express' development error page expose stack traces or request
// details. Provider and credential errors are already sanitised above; this is
// the final boundary for unexpected failures such as a database constraint.
app.use((_error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  if (res.headersSent) return;
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.ADMIN_API_PORT || 4300);
const host = process.env.ADMIN_API_HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(
    `AI-adm-D1 API listening on ${host}:${port} (legacy book AI: ${ai.name}; gateway default: ${gatewayConfig.defaultProvider})`
  );
});
