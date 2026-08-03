import { useEffect, useState } from "react";
import { adminApi } from "../api";
import type {
  AiTokenPoolRow,
  AiLogicalModelRow,
  AiModelDailyLimitRow,
  AiTokenUsageToday,
  OpenAiCredentialDailyUsageResponse
} from "../api";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { formatQuotaCount } from "./aiQuotaDisplay";
import { formatAdminErrorMessage } from "../adminErrorMessage";

/**
 * AI 每日額度中心 — Token Pool 監控與設定。
 *
 * 五種獨立限制維度（spec）：
 *   (1) 每日 Token Pool     — 共用池 (2.5M) + Sol 獨立池 (200k)
 *   (2) Provider RPM/TPM/RPD（見 AI Provider 頁）
 *   (3) 模型每日上限        — 各模型的硬上限
 *   (4) Context Window      — 單次請求容量（見 Logical Model 設定）
 *   (5) OpenAI 金鑰每日額度 — 每把金鑰獨立的每日追蹤與硬上限
 *
 * 共用池的「未配置容量」= dailyLimit − 模型硬上限合計（spec：顯示為未配置，不可借用）。
 */
export function AiQuotaCenterPage() {
  const [usage, setUsage] = useState<AiTokenUsageToday | null>(null);
  const [pools, setPools] = useState<AiTokenPoolRow[]>([]);
  const [logicalModels, setLogicalModels] = useState<AiLogicalModelRow[]>([]);
  const [modelLimits, setModelLimits] = useState<AiModelDailyLimitRow[]>([]);
  const [openAiDaily, setOpenAiDaily] = useState<OpenAiCredentialDailyUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [u, p, lm, ml, od] = await Promise.all([
        adminApi.getAiTokenUsageToday(),
        adminApi.listAiTokenPools(),
        adminApi.listAiLogicalModels(),
        adminApi.listAiModelLimits(),
        adminApi.getOpenAiCredentialDailyUsage()
      ]);
      setUsage(u);
      setPools(p.pools);
      setLogicalModels(lm.logicalModels);
      setModelLimits(ml.modelLimits);
      setOpenAiDaily(od);
    } catch (err) {
      setError(formatAdminErrorMessage(err, "無法載入額度資料"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  if (loading) return <p role="status">AI 額度中心載入中…</p>;
  if (error && !usage) {
    return <AdminErrorCard title="額度中心無法載入" description={error} onRetry={() => void loadAll()} />;
  }

  const utilizationPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;
  const utilizationClass = (ratio: number) =>
    ratio >= 0.9 ? "admin-quota-exhausted" : ratio >= 0.8 ? "admin-quota-warning" : "admin-quota-enabled";

  async function patchPool(poolId: string, input: Record<string, unknown>, label: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminApi.updateAiTokenPool(poolId, input);
      setMessage(`${label} 已更新`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  }

  async function patchModelLimit(logicalModelId: string, input: Record<string, unknown>, label: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminApi.updateAiModelLimit(logicalModelId, input);
      setMessage(`${label} 已更新`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  }

  async function patchOpenAiDailyLimit(
    credentialId: string,
    name: string,
    currentLimit: number | null
  ) {
    const raw = window.prompt(
      `${name}：每日 Token 上限（留空＝無限但仍追蹤用量；請輸入非負整數）`,
      currentLimit === null ? "" : String(currentLimit)
    );
    if (raw === null) return;

    const normalized = raw.trim();
    const dailyTokenLimit = normalized === "" ? null : Number(normalized);
    if (
      dailyTokenLimit !== null &&
      (!Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit < 0)
    ) {
      setMessage("");
      setError("每日 Token 上限必須是非負整數；留空代表無限但仍追蹤用量。");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminApi.updateOpenAiCredentialDailyLimit(credentialId, { dailyTokenLimit, enabled: true });
      setMessage(
        dailyTokenLimit === null
          ? `${name} 的獨立每日額度已啟用：無限，但仍追蹤用量`
          : `${name} 的獨立每日上限已設為 ${formatQuotaCount(dailyTokenLimit)} Tokens`
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <AdminPageHeader
        title="AI 每日額度中心"
        subtitle="Token Pool、模型上限、Context Window 與每把 OpenAI 金鑰的獨立每日額度"
      />
      {message ? <p className="admin-inline-success" role="status">{message}</p> : null}
      {error ? <p className="admin-inline-error" role="alert">{error}</p> : null}

      {/* ---- Token Pools ---- */}
      <AdminCard title="每日 Token Pool（維度 1：每日使用額度）">
        {pools.length === 0 ? (
          <p className="muted">尚無 Token Pool 設定。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table-compact">
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>類型</th>
                  <th>每日上限</th>
                  <th>已用</th>
                  <th>預留中</th>
                  <th>剩餘</th>
                  <th>使用率</th>
                  <th>未配置容量</th>
                  <th>門檻 (警/限/危)</th>
                  <th>狀態</th>
                  <th>動作</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <tr key={pool.id}>
                    <td>{pool.name}</td>
                    <td><code>{pool.poolType}</code></td>
                    <td>{formatQuotaCount(pool.dailyLimit)}</td>
                    <td>{formatQuotaCount(pool.usedTokens)}</td>
                    <td>{formatQuotaCount(pool.reservedTokens)}</td>
                    <td>{formatQuotaCount(pool.remaining)}</td>
                    <td>
                      <span className={`admin-quota-badge ${utilizationClass(pool.utilizationRatio)}`}>
                        {utilizationPercent(pool.utilizationRatio)}
                      </span>
                    </td>
                    <td>
                      {pool.unallocatedCapacity !== undefined
                        ? formatQuotaCount(pool.unallocatedCapacity)
                        : "—"}
                    </td>
                    <td>
                      {pool.warningThreshold} / {pool.throttleThreshold} / {pool.criticalThreshold}
                    </td>
                    <td>{pool.enabled ? "啟用" : "停用"}</td>
                    <td>
                      <button
                        type="button"
                        className="admin-btn secondary"
                        disabled={busy}
                        onClick={() => {
                          const next = window.prompt(`設定 ${pool.name} 每日上限（目前 ${pool.dailyLimit}）：`, String(pool.dailyLimit));
                          if (next === null) return;
                          const n = Number(next);
                          if (!Number.isFinite(n) || n <= 0) return;
                          void patchPool(pool.id, { dailyLimit: n }, pool.name);
                        }}
                      >
                        {busy ? "處理中…" : "調整上限"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          未配置容量 = 池總額 − 模型硬上限合計。模型不可借用此容量（spec：顯示為未配置，非可動態借用額度）。
        </p>
      </AdminCard>

      {/* ---- Model Daily Limits ---- */}
      <AdminCard title="模型每日上限（維度 3：每日 Token 上限）">
        {modelLimits.length === 0 ? (
          <p className="muted">尚無模型每日上限設定。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table-compact">
              <thead>
                <tr>
                  <th>Logical Model</th>
                  <th>Pool</th>
                  <th>每日上限</th>
                  <th>已用</th>
                  <th>預留中</th>
                  <th>使用率</th>
                  <th>優先序</th>
                  <th>Fallback</th>
                  <th>第二模型驗證</th>
                  <th>狀態</th>
                  <th>動作</th>
                </tr>
              </thead>
              <tbody>
                {modelLimits.map((m) => {
                  const committed = m.usedTokens + m.reservedTokens;
                  const ratio = m.dailyLimit > 0 ? committed / m.dailyLimit : 0;
                  return (
                    <tr key={m.id}>
                      <td><code>{m.logicalModelId}</code></td>
                      <td><code>{m.poolId.slice(0, 12)}</code></td>
                      <td>{formatQuotaCount(m.dailyLimit)}</td>
                      <td>{formatQuotaCount(m.usedTokens)}</td>
                      <td>{formatQuotaCount(m.reservedTokens)}</td>
                      <td>
                        <span className={`admin-quota-badge ${utilizationClass(ratio)}`}>
                          {utilizationPercent(ratio)}
                        </span>
                      </td>
                      <td>{m.priority}</td>
                      <td>{m.fallbackLogicalModelId ?? "—"}</td>
                      <td>{m.allowSecondModelVerification ? "允許" : "停用"}</td>
                      <td>{m.enabled ? "啟用" : "停用"}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-btn secondary"
                          disabled={busy}
                          onClick={() => {
                            const next = window.prompt(`設定 ${m.logicalModelId} 每日上限（目前 ${m.dailyLimit}）：`, String(m.dailyLimit));
                            if (next === null) return;
                            const n = Number(next);
                            if (!Number.isFinite(n) || n <= 0) return;
                            void patchModelLimit(m.logicalModelId, { dailyLimit: n }, m.logicalModelId);
                          }}
                        >
                          {busy ? "處理中…" : "調整上限"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      {/* ---- Logical Models (Context Window, dimension 4) ---- */}
      <AdminCard title="Logical Model Registry（維度 4：單次請求 Context Window）">
        {logicalModels.length === 0 ? (
          <p className="muted">尚無 Logical Model 設定。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table-compact">
              <thead>
                <tr>
                  <th>Logical Model</th>
                  <th>Provider</th>
                  <th>Provider Model</th>
                  <th>Context Window</th>
                  <th>Max Input</th>
                  <th>Max Output</th>
                  <th>Thinking</th>
                  <th>Tokenizer</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {logicalModels.map((lm) => (
                  <tr key={lm.id}>
                    <td><code>{lm.logicalModelId}</code></td>
                    <td><code>{lm.providerId}</code></td>
                    <td><code>{lm.providerModelName}</code></td>
                    <td>{formatQuotaCount(lm.contextWindowTokens)}</td>
                    <td>{lm.maxInputTokens !== null ? formatQuotaCount(lm.maxInputTokens) : "—"}</td>
                    <td>{formatQuotaCount(lm.maxOutputTokens)}</td>
                    <td>{lm.supportsThinking ? "支援" : "否"}</td>
                    <td>{lm.tokenizerType ?? "—"}</td>
                    <td>{lm.enabled ? "啟用" : "停用"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          Context Window 為單次請求容量限制，與每日 Token Pool（維度 1）完全獨立。Max Output 屬於單次請求，非每日上限。
        </p>
      </AdminCard>

      {/* ---- OpenAI Credential daily quota (per-key independent daily ledger) ---- */}
      <AdminCard title="OpenAI 金鑰每日額度（維度 5：每把金鑰獨立每日額度）">
        <div className="admin-inline-info" style={{ marginBottom: 8 }}>
          <strong>狀態說明：</strong>
          「尚未設定」代表這把金鑰從未啟用維度 5，並非金鑰故障；點擊「設定額度」即可啟用。
          輸入非負整數會建立每日硬上限，留空則啟用為「無限（追蹤中）」。
          此維度與共用 Token Pool（維度 1）完全獨立。
        </div>
        {openAiDaily && openAiDaily.credentials.length === 0 ? (
          <p className="muted">尚未設定 OpenAI Provider 金鑰。</p>
        ) : openAiDaily ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table-compact">
                <thead>
                  <tr>
                    <th>Provider Instance</th>
                    <th>金鑰名稱</th>
                    <th>遮罩 Key</th>
                    <th>額度狀態</th>
                    <th>每日上限</th>
                    <th>已用</th>
                    <th>預留中</th>
                    <th>剩餘</th>
                    <th>使用率</th>
                    <th>請求數</th>
                    <th>重置時間</th>
                    <th>最後使用</th>
                    <th>成本</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {openAiDaily.credentials.map((c) => {
                    const inCooldown = c.cooldownUntil !== null && new Date(c.cooldownUntil).getTime() > Date.now();
                    return (
                      <tr key={c.credentialId}>
                        <td>{c.instanceName ?? "—"}</td>
                        <td>{c.name}</td>
                        <td><code>{c.maskedApiKey}</code></td>
                        <td>
                          {!c.limitEnabled ? (
                            <span
                              className="admin-quota-badge admin-quota-disabled"
                              title="尚未啟用每把金鑰獨立每日額度；不代表金鑰故障"
                            >
                              尚未設定
                            </span>
                          ) : c.status !== "active" && c.status !== "standby" ? (
                            <span className="admin-quota-badge admin-quota-disabled">金鑰停用</span>
                          ) : inCooldown ? (
                            <span className="admin-quota-badge admin-quota-warning">冷卻中</span>
                          ) : (
                            <span className="admin-quota-badge admin-quota-enabled">已啟用</span>
                          )}
                        </td>
                        <td>
                          {!c.limitEnabled
                            ? "—"
                            : c.dailyTokenLimit !== null
                              ? formatQuotaCount(c.dailyTokenLimit)
                              : "無限（追蹤中）"}
                        </td>
                        <td>{formatQuotaCount(c.usedTokens)}</td>
                        <td>{formatQuotaCount(c.reservedTokens)}</td>
                        <td>
                          {!c.limitEnabled
                            ? "—"
                            : c.remainingTokens !== null
                              ? formatQuotaCount(c.remainingTokens)
                              : "無限"}
                        </td>
                        <td>
                          {!c.limitEnabled || c.dailyTokenLimit === null ? (
                            "—"
                          ) : (
                            <span className={`admin-quota-badge ${utilizationClass(c.utilizationRatio)}`}>
                              {utilizationPercent(c.utilizationRatio)}
                            </span>
                          )}
                        </td>
                        <td>{c.requestCount}</td>
                        <td>{c.resetAt ? new Date(c.resetAt).toLocaleString("zh-TW") : "—"}</td>
                        <td>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString("zh-TW") : "—"}</td>
                        <td
                          title={
                            c.costSource === "priced"
                              ? "依已設定的模型 Input/Output 單價計算"
                              : "此模型尚未設定 Input/Output 單價；Token 仍會照常計入"
                          }
                        >
                          {c.costSource === "priced"
                            ? `$${(c.actualCostMicroUsd / 1_000_000).toFixed(4)}`
                            : "未配置單價"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="admin-btn secondary"
                            disabled={busy}
                            onClick={() => void patchOpenAiDailyLimit(c.credentialId, c.name, c.dailyTokenLimit)}
                          >
                            {busy ? "處理中…" : c.limitEnabled ? "改上限" : "設定額度"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="admin-inline-info" style={{ marginTop: 8 }}>
              <strong>{openAiDaily.poolSummary.label}</strong>（{openAiDaily.poolSummary.credentialCount} 把）：
              已用 {formatQuotaCount(openAiDaily.poolSummary.usedTokens)}、預留中 {formatQuotaCount(openAiDaily.poolSummary.reservedTokens)}、
              請求 {openAiDaily.poolSummary.requestCount} 次。
              <span className="muted"> ⚠ 彙總資料，不代表單一金鑰用量。</span>
            </div>
          </>
        ) : (
          <p className="muted">載入中…</p>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          每把 OpenAI 金鑰獨立計算每日 Token 額度，與 Token Pool（維度 1）互相獨立。Gemini/ZAI/Kimi/Qwen 金鑰不在此列。
          「未配置單價」只表示該模型尚未在首次模型與配額設定 Input/Output 單價；Token 仍會照常計入，也不影響額度啟用。
        </p>
      </AdminCard>
    </div>
  );
}
