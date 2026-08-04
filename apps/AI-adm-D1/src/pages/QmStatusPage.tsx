import { useState, useEffect, useCallback } from "react";
import { adminApi } from "../api";
import type { QmStatusResponse } from "../api";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";

/* ── Local types (browser-safe, no server imports) ─────────── */

type QmDoctorBlocker =
  | { category: "credential"; code: string; names?: string[]; message: string }
  | { category: "tool"; code: string; name: string; message: string }
  | { category: "configuration"; code: string; message: string }
  | { category: "environment"; code: string; message: string }
  | { category: "unknown"; code: string; message: string };

type QmSystemStatus = {
  overallStatus: "pass" | "warning" | "fail";
  checkedAt: string | null;
  qmCliVersion: string | null;
  contract: {
    valid: boolean;
    version: number;
    clauses: Record<string, { status: "pass" | "fail"; errors?: string[]; warnings?: string[]; count?: number }>;
  } | null;
  doctor: {
    status: "pass" | "blocked" | "fail";
    exitCode: number;
    blockers: QmDoctorBlocker[];
    message: string | null;
  } | null;
  smoke: {
    status: "pass" | "fail" | "not_run";
    checkedAt: string | null;
    message: string | null;
  } | null;
};

/* ── Label maps ────────────────────────────────────────────── */

const OVERALL_LABELS: Record<string, string> = { pass: "通過", warning: "警告", fail: "失敗" };
const DOCTOR_LABELS: Record<string, string> = { pass: "通過", blocked: "環境阻擋", fail: "失敗" };
const SMOKE_LABELS: Record<string, string> = { pass: "通過", fail: "失敗", not_run: "尚未執行" };

const BLOCKER_CATEGORY_LABELS: Record<string, string> = {
  credential: "缺少必要憑證或仍使用 Placeholder",
  tool: "缺少系統工具",
  configuration: "設定不完整",
  environment: "其他環境阻擋",
  unknown: "未知阻擋原因",
};

function badgeClass(status: string): string {
  return `qm-badge qm-badge-${status.replace("_", "-")}`;
}

/* ── Component ─────────────────────────────────────────────── */

export function QmStatusPage() {
  const [status, setStatus] = useState<QmSystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [runningSmoke, setRunningSmoke] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await adminApi.getQmStatus();
      setStatus(res as unknown as QmSystemStatus);
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
      setStatus(res as unknown as QmSystemStatus);
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
      setStatus(res as unknown as QmSystemStatus);
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
              最後檢查時間: {new Date(status.checkedAt).toLocaleString()}
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
                  <ul>
                    {status.doctor.blockers.map((blocker, idx) => (
                      <li key={idx}>
                        <strong>{BLOCKER_CATEGORY_LABELS[blocker.category] || blocker.category}</strong>
                        {blocker.category === "credential" && "names" in blocker && blocker.names && blocker.names.length > 0 && (
                          <span className="qm-blocker-names"> ({blocker.names.join(", ")})</span>
                        )}
                        {blocker.category === "tool" && "name" in blocker && (
                          <span className="qm-blocker-names"> ({blocker.name})</span>
                        )}
                      </li>
                    ))}
                  </ul>
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
                  最後執行時間: {new Date(status.smoke.checkedAt).toLocaleString()}
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
