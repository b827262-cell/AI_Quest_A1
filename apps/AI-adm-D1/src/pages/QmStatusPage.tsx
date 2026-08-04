import { useState, useEffect, useCallback } from "react";
import { adminApi } from "../api";
import type { QmDoctorBlocker, QmStatusResponse } from "@ai-smartbook/contracts";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";

/* ── Label maps ────────────────────────────────────────────── */

const OVERALL_LABELS: Record<string, string> = { pass: "通過", warning: "警告", fail: "失敗" };
const DOCTOR_LABELS: Record<string, string> = { pass: "通過", blocked: "環境阻擋", fail: "失敗" };
const SMOKE_LABELS: Record<string, string> = { pass: "通過", fail: "失敗", not_run: "尚未執行" };

const BLOCKER_CATEGORY_LABELS: Record<string, string> = {
  credential: "憑證",
  local_secret: "本機 Secret",
  configuration: "URL／設定",
  tool: "缺少工具",
  runtime_dependency: "Runtime 相依項目",
  unknown: "未知錯誤",
};

const BLOCKER_CATEGORY_ORDER = [
  "credential",
  "local_secret",
  "configuration",
  "tool",
  "runtime_dependency",
  "unknown"
] as const;

function blockerName(blocker: QmDoctorBlocker): string {
  if ("names" in blocker && blocker.names?.length) return blocker.names.join(", ");
  if ("name" in blocker && blocker.name) return blocker.name;
  return blocker.message;
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function badgeClass(status: string): string {
  return `qm-badge qm-badge-${status.replace("_", "-")}`;
}

/* ── Component ─────────────────────────────────────────────── */

export function QmStatusPage() {
  const [status, setStatus] = useState<QmStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [runningSmoke, setRunningSmoke] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await adminApi.getQmStatus();
      setStatus(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch QM status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleValidate = async () => {
    try {
      setValidating(true);
      setError(null);
      const res = await adminApi.runQmValidate();
      setStatus(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSmoke = async () => {
    try {
      setRunningSmoke(true);
      setError(null);
      const res = await adminApi.runQmSmoke();
      setStatus(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Smoke test failed");
    } finally {
      setRunningSmoke(false);
    }
  };

  if (loading && !status) {
    return <div className="qm-loading">載入中...</div>;
  }

  if (error && !status) {
    return <AdminErrorCard title="讀取 QM 狀態失敗" description={error} onRetry={fetchStatus} />;
  }

  if (!status) return null;

  const isBusy = validating || runningSmoke;

  return (
    <>
      <AdminPageHeader title="QM 系統狀態" subtitle="檢視與管理 Quality Management 系統" />

      {error && (
        <div style={{ color: "#991b1b", background: "#fee2e2", padding: "0.75rem", borderRadius: "8px", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <div className="qm-status-grid">
        {/* ── Overall ─────────────────────────────── */}
        <AdminCard title="整體狀態">
          <div className="qm-detail-row">
            <span className="qm-detail-label">狀態</span>
            <span className={badgeClass(status.overallStatus)}>
              {OVERALL_LABELS[status.overallStatus] || status.overallStatus}
            </span>
          </div>
          <div className="qm-detail-row">
            <span className="qm-detail-label">QM CLI Version</span>
            <span>{status.qmCliVersion || "N/A"}</span>
          </div>
          {status.checkedAt && (
            <div className="qm-checked-at">
              最後檢查時間（Asia/Taipei）: {formatCheckedAt(status.checkedAt)}
            </div>
          )}
        </AdminCard>

        {/* ── Contract ────────────────────────────── */}
        <AdminCard title="Contract">
          {status.contract ? (
            <>
              <div className="qm-detail-row">
                <span className="qm-detail-label">驗證狀態</span>
                <span className={badgeClass(status.contract.valid ? "pass" : "fail")}>
                  {status.contract.valid ? "通過" : "失敗"}
                </span>
              </div>
              <div className="qm-detail-row">
                <span className="qm-detail-label">Contract Version</span>
                <span>{status.contract.version}</span>
              </div>
              {status.contract.clauses && (
                <ul className="qm-clauses-list">
                  {Object.entries(status.contract.clauses).map(([key, clause]) => (
                    <li key={key}>
                      <span className={`qm-clause-badge qm-clause-${clause.status}`}>
                        {clause.status}
                      </span>
                      <span>{key}</span>
                      {clause.count !== undefined && <span>({clause.count})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="qm-detail-label">尚未驗證</div>
          )}
        </AdminCard>

        {/* ── Doctor ──────────────────────────────── */}
        <AdminCard title="Doctor">
          {status.doctor ? (
            <>
              <div className="qm-detail-row">
                <span className="qm-detail-label">環境狀態</span>
                <span className={badgeClass(status.doctor.status)}>
                  {DOCTOR_LABELS[status.doctor.status] || status.doctor.status}
                </span>
              </div>
              {status.doctor.blockers && status.doctor.blockers.length > 0 && (
                <div className="qm-missing-tools">
                  <span className="qm-detail-label">阻擋原因</span>
                  <div className="qm-blocker-groups">
                    {BLOCKER_CATEGORY_ORDER.map((category) => {
                      const group = status.doctor?.blockers.filter((blocker) => blocker.category === category) ?? [];
                      if (group.length === 0) return null;
                      return (
                        <section className="qm-blocker-group" key={category}>
                          <h4>{BLOCKER_CATEGORY_LABELS[category]}</h4>
                          <ul>
                            {group.map((blocker, idx) => (
                              <li key={`${blocker.code}-${idx}`}>
                                <code className="qm-blocker-name">{blockerName(blocker)}</code>
                                <span>{blocker.message}</span>
                                <span className="qm-blocker-remediation">下一步：{blocker.remediation}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                  </div>
                </div>
              )}
              {status.doctor.message && (
                <div className="qm-doctor-message">{status.doctor.message}</div>
              )}
            </>
          ) : (
            <div className="qm-detail-label">尚未檢查</div>
          )}
        </AdminCard>

        {/* ── Smoke Test ─────────────────────────── */}
        <AdminCard title="Smoke Test">
          {status.smoke ? (
            <>
              <div className="qm-detail-row">
                <span className="qm-detail-label">測試狀態</span>
                <span className={badgeClass(status.smoke.status)}>
                  {SMOKE_LABELS[status.smoke.status] || status.smoke.status}
                </span>
              </div>
              {status.smoke.checkedAt && (
                <div className="qm-checked-at">
                  最後執行時間（Asia/Taipei）: {formatCheckedAt(status.smoke.checkedAt)}
                </div>
              )}
              {status.smoke.message && (
                <div className="qm-doctor-message">{status.smoke.message}</div>
              )}
            </>
          ) : (
            <div className="qm-detail-label">尚未執行</div>
          )}
        </AdminCard>
      </div>

      <div className="qm-actions">
        <button
          className="admin-btn admin-btn-primary"
          onClick={handleValidate}
          disabled={isBusy}
        >
          {validating ? "驗證中..." : "重新驗證"}
        </button>
        <button
          className="admin-btn admin-btn-secondary"
          onClick={handleSmoke}
          disabled={isBusy}
        >
          {runningSmoke ? "執行中..." : "執行 Smoke Test"}
        </button>
      </div>
    </>
  );
}
