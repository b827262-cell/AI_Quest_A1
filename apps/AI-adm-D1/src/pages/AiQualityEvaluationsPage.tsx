import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, type AiEvaluationAlert, type AiEvaluationDetail, type AiEvaluationMode, type AiEvaluationMetric, type AiEvaluationRetentionPolicy, type AiEvaluationRun, type AiEvaluationSchedule, type AiLiveEvaluationSettings, type AiLivePreflight, type AiLiveReadiness, type AiPilotSettings, type AiProductionReadiness } from "../api";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";

const DATASET_ID = "phase-4a-core";
const MODE_LABELS: Record<AiEvaluationMode, string> = { fixture: "Fixture", mock_orchestrator: "Mock", live: "Live" };

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function number(value: number | null | undefined): string { return value === null || value === undefined ? "未回報" : value.toLocaleString("zh-Hant"); }
function time(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-Hant"); }

function modeBadge(mode: AiEvaluationMode) {
  return <span className={`evaluation-mode-badge evaluation-mode-${mode}`}>{MODE_LABELS[mode]}</span>;
}

function MetricTable({ title, metrics }: { title: string; metrics: AiEvaluationMetric[] }) {
  return (
    <AdminCard title={title}>
      {metrics.length === 0 ? <p className="muted">尚無資料。</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table-compact">
            <thead><tr><th>維度</th><th>筆數</th><th>通過</th><th>通過率</th><th>平均分數</th></tr></thead>
            <tbody>{metrics.map((metric) => <tr key={metric.id}>
              <td>{metric.dimensionValue}</td><td>{metric.count}</td><td>{metric.passed}</td>
              <td>{percent(metric.passRate)}</td><td>{metric.averageScore.toFixed(3)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </AdminCard>
  );
}

export function AiQualityEvaluationsPage() {
  const [runs, setRuns] = useState<AiEvaluationRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiEvaluationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"fixture" | "mock_orchestrator" | "delete" | null>(null);
  const [baselineKey, setBaselineKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [liveSettings, setLiveSettings] = useState<AiLiveEvaluationSettings | null>(null);
  const [liveCases] = useState("3");
  const [liveBudget, setLiveBudget] = useState("");
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<AiLivePreflight | null>(null);
  const [liveBusy, setLiveBusy] = useState<"preflight" | "run" | "cancel" | null>(null);
  const [tab, setTab] = useState<"runs" | "schedules" | "governance">("runs");
  const [schedules, setSchedules] = useState<AiEvaluationSchedule[]>([]);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"fixture" | "mock_orchestrator">("fixture");
  const [scheduleCadence, setScheduleCadence] = useState<"daily" | "weekly">("daily");
  const [scheduleTime, setScheduleTime] = useState("03:00");
  const [scheduleTimezone, setScheduleTimezone] = useState("Asia/Taipei");
  const [alerts, setAlerts] = useState<AiEvaluationAlert[]>([]);
  const [retention, setRetention] = useState<AiEvaluationRetentionPolicy | null>(null);
  const [retentionPreview, setRetentionPreview] = useState<{ id: string; confirmationToken: string; candidates: Array<{ id: string; datasetId: string; datasetVersion: number; executionMode: AiEvaluationMode; reason: string; estimatedMetricCount: number; estimatedIssueCount: number }>; estimatedDeletedMetrics: number; estimatedDeletedIssues: number } | null>(null);
  const [liveReadiness, setLiveReadiness] = useState<AiLiveReadiness | null>(null);
  const [productionReadiness, setProductionReadiness] = useState<AiProductionReadiness | null>(null);
  const [pilotSettings, setPilotSettings] = useState<AiPilotSettings | null>(null);
  const [pilotBusy, setPilotBusy] = useState(false);

  const loadRuns = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await adminApi.listAiEvaluations({ datasetId: DATASET_ID, limit: 100 });
      setRuns(response.runs);
      setSelectedId((current) => current && response.runs.some((run) => run.id === current) ? current : response.runs[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "評測紀錄載入失敗");
    } finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await adminApi.getAiEvaluation(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "評測詳情載入失敗"); }
  }, []);

  const loadGovernance = useCallback(async () => {
    const [scheduleResult, alertResult, retentionResult, governanceResult] = await Promise.all([adminApi.listAiEvaluationSchedules(), adminApi.listAiEvaluationAlerts("open"), adminApi.getAiEvaluationRetention(), adminApi.getAiEvaluationGovernance()]);
    setSchedules(scheduleResult.schedules); setSchedulerEnabled(governanceResult.schedulerEnabled); setAlerts(alertResult.alerts); setRetention(retentionResult.policy);
  }, []);
  useEffect(() => { void loadRuns(); void loadGovernance(); void adminApi.getAiEvaluationSettings().then(({ settings }) => { setLiveSettings(settings); setLiveModels(settings.allowedLogicalModelIds); }).catch(() => undefined); void adminApi.getAiLiveReadiness().then(setLiveReadiness).catch(() => undefined); void adminApi.getAiProductionReadiness().then(setProductionReadiness).catch(() => undefined); void adminApi.getAiPilotSettings().then(({ settings }) => setPilotSettings(settings)).catch(() => undefined); }, [loadRuns, loadGovernance]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(null); }, [selectedId, loadDetail]);

  const comparableRuns = useMemo(() => {
    if (!detail) return [];
    return runs.filter((run) => run.datasetId === detail.run.datasetId && run.datasetVersion === detail.run.datasetVersion && run.executionMode === detail.run.executionMode);
  }, [detail, runs]);
  const grouped = useMemo(() => {
    const map = new Map<string, AiEvaluationMetric[]>();
    for (const metric of detail?.metrics ?? []) map.set(metric.dimension, [...(map.get(metric.dimension) ?? []), metric]);
    return map;
  }, [detail]);

  async function run(mode: "fixture" | "mock_orchestrator") {
    setBusy(mode); setError(""); setMessage("");
    try {
      const [baselineMode, baselineRunId] = baselineKey.split("|");
      const result = await adminApi.startAiEvaluation({ datasetId: DATASET_ID, executionMode: mode, baselineRunId: baselineMode === mode ? baselineRunId : undefined }, `eval-ui-${mode}-${Date.now()}`);
      setMessage(result.reused ? "已沿用相同 Idempotency Key 的評測紀錄。" : `${MODE_LABELS[mode]} 評測完成。`);
      await loadRuns(); setSelectedId(result.run.id); await loadDetail(result.run.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "評測執行失敗"); }
    finally { setBusy(null); }
  }

  async function download(format: "json" | "markdown") {
    if (!selectedId) return;
    try {
      const blob = await adminApi.downloadAiEvaluationReport(selectedId, format);
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `ai-evaluation-${selectedId}.${format === "json" ? "json" : "md"}`;
      anchor.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "報告下載失敗"); }
  }

  async function remove() {
    if (!selectedId || !window.confirm("確定刪除此評測紀錄及其安全指標？")) return;
    setBusy("delete");
    try { await adminApi.deleteAiEvaluation(selectedId); setMessage("評測紀錄已刪除。"); setSelectedId(null); setDetail(null); await loadRuns(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "刪除失敗"); }
    finally { setBusy(null); }
  }

  async function livePreflight() {
    if (!liveSettings) return;
    setLiveBusy("preflight"); setError(""); setPreflight(null);
    try {
      const result = await adminApi.preflightAiEvaluation({ datasetId: DATASET_ID, maxCases: Number(liveCases), maxTokenBudget: Number(liveBudget), logicalModelIds: liveModels });
      setPreflight(result);
      if (!result.allowed) setError(`Live 預檢未通過：${result.blockers.join(", ")}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Live 預檢失敗"); }
    finally { setLiveBusy(null); }
  }

  async function liveRun() {
    if (!preflight?.allowed || !preflight.confirmationToken || !window.confirm("確認執行受控 Live Evaluation？這會呼叫真實模型，但只使用 Evaluation Pool，不會使用 Personal Credential 或 Production Pool。")) return;
    setLiveBusy("run"); setError("");
    try {
      const result = await adminApi.startLiveAiEvaluation({ datasetId: DATASET_ID, maxCases: Number(liveCases), maxTokenBudget: Number(liveBudget), logicalModelIds: liveModels, dryRunId: preflight.dryRunId, confirmationToken: preflight.confirmationToken }, `eval-live-ui-${preflight.dryRunId}`);
      setMessage(result.reused ? "已沿用 Live Run。" : "Live Evaluation 已完成或安全停止。"); setPreflight(null); await loadRuns(); setSelectedId(result.run.id); await loadDetail(result.run.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Live Evaluation 失敗"); }
    finally { setLiveBusy(null); }
  }

  async function cancelLive() {
    if (!selectedId) return;
    setLiveBusy("cancel");
    try { await adminApi.cancelAiEvaluation(selectedId); setMessage("已提出停止要求；服務會在下一個模型呼叫前停止。"); await loadRuns(); await loadDetail(selectedId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "停止 Live Run 失敗"); }
    finally { setLiveBusy(null); }
  }

  async function previewRetention() {
    try { const result = await adminApi.previewAiEvaluationRetention(); setRetentionPreview(result); setMessage(`Retention Preview：${result.candidates.length} 筆候選，不會立即刪除。`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Retention Preview 失敗"); }
  }

  async function executeRetention() {
    if (!retentionPreview || !window.confirm("確認執行 Retention？受保護的 Running、Baseline、最新成功與退化紀錄不會刪除。")) return;
    try { const result = await adminApi.runAiEvaluationRetention({ previewId: retentionPreview.id, confirmationToken: retentionPreview.confirmationToken }); setMessage(`Retention 已刪除 ${result.deleted} 筆。`); setRetentionPreview(null); await loadRuns(); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Retention 執行失敗"); }
  }

  async function toggleSchedule(schedule: AiEvaluationSchedule) {
    try { await adminApi.updateAiEvaluationSchedule(schedule.id, { enabled: !schedule.enabled }); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "排程更新失敗"); }
  }

  async function createSchedule() {
    try { await adminApi.createAiEvaluationSchedule({ enabled: false, datasetId: DATASET_ID, datasetVersion: 1, executionMode: scheduleMode, cadence: scheduleCadence, scheduledTime: scheduleTime, timezone: scheduleTimezone, baselinePolicy: "latest_comparable" }); setMessage("離線排程已建立（預設暫停）。"); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "排程建立失敗"); }
  }

  async function deleteSchedule(schedule: AiEvaluationSchedule) {
    if (!window.confirm("確認刪除這個離線排程？既有評測紀錄不會刪除。")) return;
    try { await adminApi.deleteAiEvaluationSchedule(schedule.id); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "排程刪除失敗"); }
  }

  async function toggleScheduler() {
    try { const result = await adminApi.setAiEvaluationScheduler(!schedulerEnabled); setSchedulerEnabled(result.schedulerEnabled); setMessage(result.schedulerEnabled ? "離線 Scheduler 已啟用。" : "離線 Scheduler 已暫停。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Scheduler 更新失敗"); }
  }

  async function resolveAlert(alert: AiEvaluationAlert) {
    try { await adminApi.resolveAiEvaluationAlert(alert.id); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "告警更新失敗"); }
  }

  async function acknowledgeAlert(alert: AiEvaluationAlert) {
    try { await adminApi.acknowledgeAiEvaluationAlert(alert.id); await loadGovernance(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "告警確認失敗"); }
  }

  async function disablePilot() {
    setPilotBusy(true); setError("");
    try { const result = await adminApi.disableAiPilot(); setPilotSettings(result.settings); setMessage("Pilot Kill Switch 已生效，新請求不會進入 Pilot。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Pilot 停用失敗"); }
    finally { setPilotBusy(false); }
  }

  async function savePilotSettings() {
    if (!pilotSettings) return;
    setPilotBusy(true); setError("");
    try { const result = await adminApi.saveAiPilotSettings({ enabled: pilotSettings.enabled, trafficPercentage: pilotSettings.trafficPercentage, allowedTaskCategories: pilotSettings.allowedTaskCategories, allowVerification: pilotSettings.allowVerification, allowAdjudication: pilotSettings.allowAdjudication, maxModelCallsPerRequest: pilotSettings.maxModelCallsPerRequest, pilotVersion: pilotSettings.pilotVersion, stopPolicy: pilotSettings.stopPolicy }); setPilotSettings(result.settings); setMessage("Pilot 設定已保存；只有通過 Readiness Review 才能啟用。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Pilot 設定保存失敗"); }
    finally { setPilotBusy(false); }
  }

  if (loading) return <p role="status">AI 品質評測載入中…</p>;
  if (error && runs.length === 0) return <AdminErrorCard title="AI 品質評測無法載入" description={error} onRetry={() => void loadRuns()} />;

  return <div>
    <AdminPageHeader title="AI 品質評測" subtitle="固定離線資料集的回歸檢查與多模型品質量測" actions={<>
      <label className="evaluation-baseline-picker">Baseline
        <select value={baselineKey} onChange={(event) => setBaselineKey(event.target.value)} disabled={busy !== null}>
          <option value="">自動使用最新可比較 Run</option>
          {runs.filter((runItem) => runItem.status === "completed" && runItem.datasetId === DATASET_ID && runItem.datasetVersion === 1).map((runItem) => <option key={runItem.id} value={`${runItem.executionMode}|${runItem.id}`}>{MODE_LABELS[runItem.executionMode]} · {time(runItem.createdAt)}</option>)}
        </select>
      </label>
      <button className="admin-btn secondary" type="button" disabled={busy !== null} onClick={() => void run("fixture")}>{busy === "fixture" ? "執行中…" : "執行 Fixture 評測"}</button>
      <button className="admin-btn" type="button" disabled={busy !== null} onClick={() => void run("mock_orchestrator")}>{busy === "mock_orchestrator" ? "執行中…" : "執行 Mock 評測"}</button>
    </>} />
    {message && <p className="admin-inline-success" role="status">{message}</p>}
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    <div className="evaluation-notice" role="note">{detail?.run.executionMode === "live" ? "Live 結果僅代表指定評測資料集，不代表全部學生問題的真實世界準確率。" : "此結果來自固定離線評測資料與模擬回應，僅用於回歸檢查，不代表正式模型的真實世界準確率。"}</div>

    <div className="evaluation-tabs" role="tablist" aria-label="評測管理分頁">
      <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>評測結果</button>
      <button type="button" role="tab" aria-selected={tab === "schedules"} className={tab === "schedules" ? "active" : ""} onClick={() => setTab("schedules")}>排程與自動執行</button>
      <button type="button" role="tab" aria-selected={tab === "governance"} className={tab === "governance" ? "active" : ""} onClick={() => setTab("governance")}>Retention 與告警</button>
    </div>

    {tab === "schedules" && <AdminCard title="Fixture／Mock 排程">
      <p className="muted">Scheduler：{schedulerEnabled ? "啟用" : "停用"}（Server Timer 仍需明確設定 AI_EVALUATION_SCHEDULER_ENABLED=true）</p>
      <p className="muted">只允許 Fixture 與 Mock Orchestrator；Live Evaluation 不可排程。Timezone 必須由排程明確保存。</p>
      <button type="button" className="admin-btn secondary" onClick={() => void toggleScheduler()}>{schedulerEnabled ? "暫停 Scheduler" : "啟用 Scheduler"}</button>
      <div className="evaluation-schedule-form"><label>Mode<select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as "fixture" | "mock_orchestrator")}><option value="fixture">Fixture</option><option value="mock_orchestrator">Mock</option></select></label><label>Cadence<select value={scheduleCadence} onChange={(event) => setScheduleCadence(event.target.value as "daily" | "weekly")}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Time<input value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} inputMode="numeric" /></label><label>Timezone<input value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} /></label><button type="button" className="admin-btn secondary" onClick={() => void createSchedule()}>建立排程</button></div>
      {schedules.length === 0 ? <p className="muted">尚無排程。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>Dataset</th><th>Mode</th><th>Cadence</th><th>Time／Timezone</th><th>狀態</th><th>操作</th></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id}><td>{schedule.datasetId}@{schedule.datasetVersion}</td><td>{MODE_LABELS[schedule.executionMode]}</td><td>{schedule.cadence}</td><td>{schedule.scheduledTime} · {schedule.timezone}</td><td>{schedule.enabled ? "啟用" : "暫停"}</td><td><button type="button" className="admin-btn ghost" onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? "暫停" : "恢復"}</button><button type="button" className="admin-btn ghost" onClick={() => void deleteSchedule(schedule)}>刪除</button></td></tr>)}</tbody></table></div>}
    </AdminCard>}

    {tab === "governance" && <>
      <AdminCard title="Retention Policy"><p className="muted">Retention：{retention?.enabled ? "啟用" : "停用"}；預設停用，不會自動刪除。</p><p className="muted">保留最新成功：{retention?.preserveLatestSuccessful ?? "—"}；每 Dataset／Mode 上限：{retention?.maxRunsPerDatasetMode ?? "—"}。</p><div><button type="button" className="admin-btn secondary" onClick={() => void previewRetention()}>產生 Candidate Preview</button>{retentionPreview && <button type="button" className="admin-btn danger" onClick={() => void executeRetention()}>確認執行刪除</button>}</div>{retentionPreview && <p role="status">候選 {retentionPreview.candidates.length} 筆；Metrics {retentionPreview.estimatedDeletedMetrics}；Issues {retentionPreview.estimatedDeletedIssues}。Preview 短效且尚未刪除。</p>}</AdminCard>
      <AdminCard title="Open Alerts">{alerts.length === 0 ? <p className="muted">目前沒有未處理告警。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>Severity</th><th>Type</th><th>Summary</th><th>Created</th><th>操作</th></tr></thead><tbody>{alerts.map((alert) => <tr key={alert.id}><td>{alert.severity}</td><td>{alert.type}</td><td>{alert.safeSummary}</td><td>{time(alert.createdAt)}</td><td><button type="button" className="admin-btn ghost" onClick={() => void acknowledgeAlert(alert)}>Acknowledge</button><button type="button" className="admin-btn ghost" onClick={() => void resolveAlert(alert)}>Resolve</button></td></tr>)}</tbody></table></div>}</AdminCard>
    </>}

    {tab === "runs" && <AdminCard title="Live Evaluation">
      <p className="muted">Live Evaluation：{liveSettings?.enabled ? "已啟用（仍需每次 Dry Run 與二次確認）" : "停用"}</p>
      <p className="muted">只允許 Server Allowlist 的 Dataset／Logical Model；不使用 Personal Credential、正式學生 Token Pool 或正式 Usage Log。</p>
      {liveSettings?.enabled ? <div className="evaluation-live-controls">
        <label>Smoke Cases<input type="number" min="3" max="3" value={liveCases} readOnly disabled={liveBusy !== null} /></label>
        <label>本次 Token 上限<input type="number" min="1" value={liveBudget} onChange={(event) => setLiveBudget(event.target.value)} disabled={liveBusy !== null} /></label>
        <label>Logical Models<select multiple value={liveModels} onChange={(event) => setLiveModels([...event.target.selectedOptions].map((option) => option.value))} disabled={liveBusy !== null}>{liveSettings.allowedLogicalModelIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <div><button type="button" className="admin-btn secondary" onClick={() => void livePreflight()} disabled={liveBusy !== null}>{liveBusy === "preflight" ? "預檢中…" : "執行 Dry Run 預檢"}</button>{preflight?.allowed && <button type="button" className="admin-btn danger" onClick={() => void liveRun()} disabled={liveBusy !== null}>{liveBusy === "run" ? "執行中…" : "二次確認並啟動 Live"}</button>}</div>
        {preflight && <div className={`evaluation-live-preflight ${preflight.allowed ? "allowed" : "blocked"}`} role="status"><strong>{preflight.allowed ? "Preflight Passed" : "Preflight Rejected"}</strong><span>Cases {preflight.selectedCaseCount} · 最壞 Calls {preflight.estimatedMaximumModelCalls} · 最壞 Tokens {number(preflight.estimatedMaximumTokens)}</span><span>Evaluation Pool 剩餘 {number(preflight.evaluationPoolRemainingTokens)} · 今日剩餘 {number(preflight.dailyRemainingTokens)}</span>{preflight.blockers.length > 0 && <span>Blockers：{preflight.blockers.join(", ")}</span>}</div>}
      </div> : <p className="muted">需由管理員先在 Server 設定啟用、Allowlist、Evaluation Pool 與預算；本頁不提供任意 Provider／Credential 輸入。</p>}
    </AdminCard>}

    {tab === "runs" && <AdminCard title="Production Readiness／學生 Pilot">
      <p className="muted">Pilot 預設停用；未通過三個 Gate 前，學生請求沿用既有流程，不進入多模型融合／裁決 Pilot。</p>
      <div className="evaluation-summary-grid">
        {liveReadiness && [["Live Readiness", liveReadiness.ready ? "Ready" : "Blocked"], ["Credential", liveReadiness.credentialReady ? "Ready" : "Blocked"], ["Evaluation Pool", liveReadiness.evaluationPoolReady ? "Ready" : "Blocked"], ["Budget", liveReadiness.budgetReady ? "Ready" : "Blocked"], ["Allowlist", liveReadiness.allowlistReady ? "Ready" : "Blocked"], ["Live", liveReadiness.liveEnabled ? "Enabled" : "Disabled"]].map(([label, value]) => <div className="evaluation-summary-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      {liveReadiness && liveReadiness.blockers.length > 0 && <p className="admin-inline-error" role="status">Readiness Blockers：{liveReadiness.blockers.join(", ")}</p>}
      {productionReadiness && <p className={productionReadiness.status === "ready_for_pilot" ? "admin-inline-success" : "admin-inline-error"} role="status">Production Readiness：{productionReadiness.status}{productionReadiness.liveRunId ? ` · Smoke Run ${productionReadiness.liveRunId}` : ""}</p>}
      {pilotSettings && <div className="evaluation-schedule-form">
        <label>Traffic %<input type="number" min="0" max="100" value={pilotSettings.trafficPercentage} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, trafficPercentage: Number(event.target.value) })} /></label>
        <label>Categories<select multiple value={pilotSettings.allowedTaskCategories} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, allowedTaskCategories: [...event.target.selectedOptions].map((option) => option.value as "programming" | "mathematics" | "knowledge") })}><option value="mathematics">Mathematics</option><option value="programming">Programming</option><option value="knowledge">Knowledge</option></select></label>
        <label>Max Calls<input type="number" min="1" max="3" value={pilotSettings.maxModelCallsPerRequest} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, maxModelCallsPerRequest: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={pilotSettings.enabled} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, enabled: event.target.checked })} /> 啟用 Pilot（需 Readiness）</label>
        <label><input type="checkbox" checked={pilotSettings.allowVerification} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, allowVerification: event.target.checked })} /> Verification</label>
        <label><input type="checkbox" checked={pilotSettings.allowAdjudication} disabled={pilotBusy} onChange={(event) => setPilotSettings({ ...pilotSettings, allowAdjudication: event.target.checked })} /> Adjudication</label>
        <button type="button" className="admin-btn secondary" disabled={pilotBusy} onClick={() => void savePilotSettings()}>保存 Pilot 設定</button>
        <button type="button" className="admin-btn danger" disabled={pilotBusy || !pilotSettings.enabled} onClick={() => void disablePilot()}>立即停用 Pilot</button>
      </div>}
    </AdminCard>}

    {tab === "runs" && <AdminCard title="Evaluation Runs">
      {runs.length === 0 ? <p className="muted">尚無評測紀錄。可執行 Fixture 或 Mock 評測。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>Dataset</th><th>Mode</th><th>狀態</th><th>案例</th><th>通過率</th><th>執行時間</th></tr></thead><tbody>
        {runs.map((runItem) => <tr key={runItem.id} className="admin-table-row-clickable" onClick={() => setSelectedId(runItem.id)}>
          <td><button className="admin-link-button" type="button" onClick={() => setSelectedId(runItem.id)}>{runItem.datasetId}@{runItem.datasetVersion}</button></td>
          <td>{modeBadge(runItem.executionMode)}</td><td>{runItem.status}</td><td>{runItem.passedCases}/{runItem.totalCases}</td><td>{percent(runItem.passRate)}</td><td>{time(runItem.createdAt)}</td>
        </tr>)}
      </tbody></table></div>}
    </AdminCard>}

    {detail && <>
      <AdminPageHeader title={`Run Detail：${detail.run.id}`} subtitle={`${detail.run.datasetId}@${detail.run.datasetVersion} · ${time(detail.run.createdAt)}`} actions={<>
        <button type="button" className="admin-btn ghost" onClick={() => void download("json")}>下載 JSON</button>
        <button type="button" className="admin-btn ghost" onClick={() => void download("markdown")}>下載 Markdown</button>
        {detail.run.executionMode === "live" && detail.run.status === "running" && <button type="button" className="admin-btn danger" disabled={liveBusy !== null} onClick={() => void cancelLive()}>{liveBusy === "cancel" ? "停止要求中…" : "停止 Live Run"}</button>}
        <button type="button" className="admin-btn danger" disabled={busy !== null || liveBusy !== null} onClick={() => void remove()}>刪除</button>
      </>} />
      <div className="evaluation-summary-grid">
        {[ ["Mode", modeBadge(detail.run.executionMode)], ["總案例", number(detail.run.totalCases)], ["Pass Rate", percent(detail.run.passRate)], ["Average Score", detail.run.averageScore.toFixed(3)], ["Conflict Rate", percent(detail.run.conflictRate)], ["Unresolved Rate", percent(detail.run.unresolvedRate)], ["P95 Latency", `${detail.run.p95DurationMs.toFixed(1)} ms`], ["Model Calls", detail.run.averageModelCalls.toFixed(2)], ["Total Tokens", number(detail.run.totalTokens)] ].map(([label, value], index) => <div className="evaluation-summary-card" key={`summary-${index}`}><span>{label}</span><strong>{value}</strong></div>)}
        {detail.run.executionMode === "live" && [["Token Budget", number(detail.run.maxTokenBudget)], ["Actual Tokens", number(detail.run.consumedTokens)], ["Evaluation Pool", detail.run.evaluationPoolId ?? "未配置"], ["Logical Models", detail.run.logicalModelIds?.join(", ") || "未回報"], ["Providers", detail.run.providerIds?.join(", ") || "未回報"]].map(([label, value], index) => <div className="evaluation-summary-card" key={`live-summary-${index}`}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <MetricTable title="Category Breakdown" metrics={grouped.get("category") ?? []} />
      <MetricTable title="Difficulty Breakdown" metrics={grouped.get("difficulty") ?? []} />
      <MetricTable title="Outcome Breakdown" metrics={grouped.get("outcome") ?? []} />
      <MetricTable title="Confidence Calibration（離線經驗通過率）" metrics={grouped.get("confidence") ?? []} />
      <AdminCard title="Comparable Trend"><p className="muted">只顯示相同 Dataset、Version、Mode；不混合 Fixture、Mock、Live 或不同版本。</p>{comparableRuns.length === 0 ? <p className="muted">尚無可比較執行紀錄。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>時間</th><th>Pass Rate</th><th>Score</th><th>Conflict</th><th>Unresolved</th><th>P95</th><th>Calls</th><th>Tokens</th></tr></thead><tbody>{comparableRuns.map((item) => <tr key={item.id}><td>{time(item.createdAt)}</td><td>{percent(item.passRate)}</td><td>{item.averageScore.toFixed(3)}</td><td>{percent(item.conflictRate)}</td><td>{percent(item.unresolvedRate)}</td><td>{item.p95DurationMs.toFixed(1)} ms</td><td>{item.averageModelCalls.toFixed(2)}</td><td>{number(item.totalTokens)}</td></tr>)}</tbody></table></div>}</AdminCard>
      <AdminCard title="Baseline Comparison">{!detail.regression ? <p className="muted">尚未選定可比較 Baseline。</p> : !detail.regression.comparable ? <p className="muted">此執行結果與所選 Baseline 不可直接比較。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>Pass Rate Delta</th><th>Score Delta</th><th>P95 Delta</th><th>Model Calls Delta</th><th>Token Delta</th><th>Regression Issues</th></tr></thead><tbody><tr><td>{percent(detail.regression.passRateDelta)}</td><td>{detail.regression.averageScoreDelta.toFixed(3)}</td><td>{detail.regression.p95LatencyDeltaMs.toFixed(1)} ms</td><td>{detail.regression.averageModelCallsDelta.toFixed(2)}</td><td>{number(detail.regression.totalTokenDelta)}</td><td>{detail.regression.regressions.length}</td></tr></tbody></table></div>}</AdminCard>
      <AdminCard title={`Failed Cases（${detail.issues.length}）`}>{detail.issues.length === 0 ? <p className="muted">沒有失敗案例。</p> : <div className="admin-table-wrap"><table className="admin-table-compact"><thead><tr><th>Case ID</th><th>Category</th><th>Expected Kind</th><th>Score</th><th>Issue</th><th>Severity</th><th>Safe Summary</th></tr></thead><tbody>{detail.issues.map((issue) => <tr key={issue.id}><td>{issue.caseId}</td><td>{issue.category}</td><td>{issue.expectedKind}</td><td>{issue.score.toFixed(3)}</td><td>{issue.code}</td><td>{issue.severity}</td><td>{issue.safeSummary ?? "—"}</td></tr>)}</tbody></table></div>}</AdminCard>
    </>}
  </div>;
}
