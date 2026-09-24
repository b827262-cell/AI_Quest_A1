/**
 * D-07 page-startup orchestration for the durable local-model cache.
 *
 * This module is intentionally free of React and of any browser side effect at
 * import time so the *decision* logic (probe -> warm / background repair /
 * wait-for-gesture) is unit-testable headlessly with the same fake Cache
 * objects used by `local-model-cache.test.mjs`.  `page.tsx` only calls these
 * helpers; every decision guarantees `blocksUi === false` so the OTHER/UI
 * consent flow and the Google AI handoff are never delayed by cache work.
 */
import { QWEN3_TEST_MODEL_ID } from "./chrome-built-in-ai";
import {
  createModelCacheFetch,
  ensureLocalModelCache,
  probeLocalModelCache,
  readManifest,
  type CacheAsset,
  type CacheEnvOverrides,
  type EnsureProgress,
  type EnsureResult,
  type LocalModelCacheState,
  type ModelCacheIdentity,
} from "./local-model-cache";

/**
 * The cache is keyed by the very id the Auto submit path requests, so it is
 * imported rather than repeated: a copy that drifts would verify one model's
 * bytes while Transformers.js downloads another.
 */
export const LOCAL_MODEL_ID = QWEN3_TEST_MODEL_ID;

/**
 * Bumping this invalidates every previously cached probe so a new application
 * build re-verifies its artifact set instead of trusting stale byte sizes.
 */
export const LOCAL_MODEL_REVISION = "d07-q3-0.6b-r1";

export const LOCAL_MODEL_IDENTITY: ModelCacheIdentity = {
  modelId: LOCAL_MODEL_ID,
  revision: LOCAL_MODEL_REVISION,
};

export type StartupAction = "warm" | "repair" | "pristine" | "unsupported";

export type StartupDecision = {
  action: StartupAction;
  /** Invariant for every action: cache work must never block the render path. */
  blocksUi: false;
  needsUserGesture: boolean;
  assetCount: number;
  missingCount: number;
  corruptCount: number;
  stale: boolean;
  detail: string;
};

/**
 * Pure startup policy - zero network, zero side effects.
 *
 *  - `warm`        verified complete cache: the model resolves from Cache
 *                  Storage with no GET, so nothing further is scheduled.
 *  - `repair`      an already-provisioned set is missing/corrupt or drifted
 *                  revision: a background, resumable re-ensure fixes only the
 *                  affected subset (safe: byte sizes are already known).
 *  - `pristine`    nothing trustworthy cached yet: the ~618MB cold download
 *                  must wait for the learner's first IT/ACCOUNTING submit (a
 *                  gesture); we never auto-consume bandwidth for OTHER/UI.
 *  - `unsupported` Cache Storage is unavailable: Transformers.js loads over
 *                  the network exactly as before.
 */
export function decideStartupAction(state: LocalModelCacheState): StartupDecision {
  if (!state.supported) {
    return {
      action: "unsupported",
      blocksUi: false,
      needsUserGesture: false,
      assetCount: 0,
      missingCount: 0,
      corruptCount: 0,
      stale: false,
      detail: "Cache Storage is unavailable; Transformers.js loads artifacts over the network directly.",
    };
  }
  if (state.complete) {
    return {
      action: "warm",
      blocksUi: false,
      needsUserGesture: false,
      assetCount: state.artifactCount,
      missingCount: 0,
      corruptCount: 0,
      stale: false,
      detail: "Verified warm cache: the model loads from Cache Storage with zero network GET.",
    };
  }
  const needsAttention = state.stale || state.missingCount > 0 || state.corruptCount > 0;
  if (state.artifactCount > 0 && needsAttention) {
    return {
      action: "repair",
      blocksUi: false,
      needsUserGesture: false,
      assetCount: state.artifactCount,
      missingCount: state.missingCount,
      corruptCount: state.corruptCount,
      stale: state.stale,
      detail: `Background repair scheduled: ${state.missingCount} missing / ${state.corruptCount} corrupt${state.stale ? " / version drift" : ""}.`,
    };
  }
  return {
    action: "pristine",
    blocksUi: false,
    needsUserGesture: true,
    assetCount: state.artifactCount,
    missingCount: state.missingCount,
    corruptCount: state.corruptCount,
    stale: state.stale,
    detail: "No verified cache yet; the download begins on the first IT/ACCOUNTING submit (user gesture).",
  };
}

export type BootstrapHandle = {
  decision: StartupDecision;
  /**
   * The background repair promise (resolves to `null` when nothing is
   * scheduled). Callers must NOT await it on the render path - it is surfaced
   * so the UI can update a badge when it eventually finishes.
   */
  ensure: Promise<EnsureResult | null>;
};

export type BootstrapOptions = {
  identity?: ModelCacheIdentity;
  env?: CacheEnvOverrides;
  signal?: AbortSignal;
  onStatus?: (decision: StartupDecision) => void;
  onProgress?: (progress: EnsureProgress) => void;
};

/**
 * Probe the durable cache exactly once and, only when an already-provisioned
 * set is incomplete/drifted, schedule a resumable background repair. Returns
 * after the zero-GET probe; never blocks the caller.
 */
export async function runLocalModelBootstrap(
  options: BootstrapOptions = {},
): Promise<BootstrapHandle> {
  const identity = options.identity ?? LOCAL_MODEL_IDENTITY;
  const env = options.env ?? {};
  const state = await probeLocalModelCache(identity, env);
  const decision = decideStartupAction(state);
  options.onStatus?.(decision);

  if (decision.action !== "repair") return { decision, ensure: Promise.resolve(null) };

  const manifest = await readManifest(identity, env);
  // A revision/schema drift means the recorded byte sizes no longer describe
  // the target build, so drop them and let the re-download re-measure. A
  // same-revision gap keeps its expectedBytes so a truncated file still fails
  // closed and is re-fetched until it matches.
  const assets: CacheAsset[] = (manifest?.assets ?? []).map((asset) =>
    decision.stale ? { url: asset.url, expectedBytes: 0 } : asset,
  );
  const ensure = ensureLocalModelCache({
    identity,
    assets,
    env,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return { decision, ensure };
}

export type ModelFetchAdapter = {
  /** Drop-in `fetch` to hand to the Transformers.js backend via AskOptions. */
  fetch: typeof fetch;
  /** Artifacts measured + stored during this session (for manifest sync). */
  assets: () => CacheAsset[];
  /**
   * Record the artifacts Transformers.js actually used into the persistent
   * manifest so the *next* boot probe/repair has an authoritative target set.
   * Re-verifying already-warm bytes costs zero network GET.
   */
  persistManifest: () => Promise<EnsureResult | null>;
};

export type ModelFetchAdapterOptions = {
  identity?: ModelCacheIdentity;
  env?: CacheEnvOverrides;
  networkFetch?: typeof fetch;
};

/**
 * Build the cache-backed fetch used on the submit path. A warm artifact is
 * returned straight from Cache Storage (zero GET); a cold one is fetched,
 * measured and stored, and `persistManifest` later folds the discovered set
 * into the manifest without re-downloading.
 */
export function createLocalModelFetchAdapter(
  options: ModelFetchAdapterOptions = {},
): ModelFetchAdapter {
  const identity = options.identity ?? LOCAL_MODEL_IDENTITY;
  const env = options.env ?? {};
  const networkFetch =
    options.networkFetch ??
    (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
      ? (globalThis.fetch as typeof fetch)
      : (undefined as unknown as typeof fetch));
  const collected = new Map<string, CacheAsset>();
  const wrapped = createModelCacheFetch(identity, networkFetch, env, (asset) => {
    collected.set(asset.url, asset);
  });
  return {
    fetch: wrapped,
    assets: () => [...collected.values()],
    async persistManifest() {
      const assets = [...collected.values()];
      if (assets.length === 0) return null;
      return ensureLocalModelCache({ identity, assets, env });
    },
  };
}
