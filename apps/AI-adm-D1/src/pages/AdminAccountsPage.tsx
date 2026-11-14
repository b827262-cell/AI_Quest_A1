import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, type AdminAccount, type AdminStudentUser, type RiskLevel } from "../api";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-Hant");
}

const RISK_META: Record<RiskLevel, { label: string; badge: string; dot: "green" | "yellow" | "red" }> = {
  safe:      { label: "安全",  badge: "published", dot: "green"  },
  risk:      { label: "注意",  badge: "draft",     dot: "yellow" },
  dangerous: { label: "高風險", badge: "failed",    dot: "red"    },
};

const RISK_OPTIONS: RiskLevel[] = ["safe", "risk", "dangerous"];

function osIcon(os: string): string {
  const l = os.toLowerCase();
  if (l.includes("linux"))                                          return "🐧";
  if (l.includes("android"))                                        return "🤖";
  if (l.includes("windows"))                                        return "🪟";
  if (l.includes("mac") || l.includes("ios") ||
      l.includes("iphone") || l.includes("ipad"))                   return "🍎";
  return "💻";
}

function deviceIcon(type: string): string {
  const l = type.toLowerCase();
  if (l.includes("mobile") || l.includes("phone")) return "📱";
  return "🖥️";
}

export function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [studentUsers, setStudentUsers] = useState<AdminStudentUser[]>([]);
  const [schoolFilter, setSchoolFilter] = useState<string>("");
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [busyId, setBusyId]     = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    return adminApi
      .listAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        setStudentUsers(r.studentUsers ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 自動彙整 accounts 與 studentUsers 中非空的 schoolName 作為篩選選項。
  const schoolOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const a of accounts) {
      const s = a.schoolName?.trim();
      if (s) seen.add(s);
    }
    for (const u of studentUsers) {
      const s = u.schoolName?.trim();
      if (s) seen.add(s);
    }
    return Array.from(seen).sort((x, y) => x.localeCompare(y, "zh-Hant"));
  }, [accounts, studentUsers]);

  const visibleAccounts = useMemo(() => {
    if (!schoolFilter) return accounts;
    return accounts.filter((a) => (a.schoolName?.trim() ?? "") === schoolFilter);
  }, [accounts, schoolFilter]);

  const visibleStudentUsers = useMemo(() => {
    if (!schoolFilter) return studentUsers;
    return studentUsers.filter((u) => (u.schoolName?.trim() ?? "") === schoolFilter);
  }, [studentUsers, schoolFilter]);

  const runAction = useCallback(
    async (sessionId: string, action: () => Promise<unknown>) => {
      setBusyId(sessionId);
      setActionError("");
      try {
        await action();
        await load();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const onChangeRisk = (a: AdminAccount, riskLevel: RiskLevel) => {
    if (riskLevel === a.riskLevel) return;
    void runAction(a.sessionId, () => adminApi.setAccountRisk(a.sessionId, riskLevel));
  };

  const onToggleBlock = (a: AdminAccount) => {
    if (a.isBlocked) {
      void runAction(a.sessionId, () => adminApi.unblockAccount(a.sessionId));
      return;
    }
    const reason = window.prompt("封鎖原因（可留空）：", "") ?? null;
    void runAction(a.sessionId, () => adminApi.blockAccount(a.sessionId, reason || null));
  };

  const header = (
    <AdminPageHeader
      title="帳戶管理"
      subtitle="查看前台使用者編號、IP、裝置與上線狀態，並進行風險標記與封鎖管理"
    />
  );

  if (error) {
    return (
      <div>
        {header}
        <AdminErrorCard
          title="帳戶資料讀取失敗"
          description="後端目前無法回應，請確認 API Server 是否啟動，或稍後重新整理。"
          code={error}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div>
      {header}
      <AdminCard title={`使用者編號（${accounts.length}）`}>
        {actionError && (
          <p className="badge failed" style={{ marginBottom: 12 }}>
            操作失敗：{actionError}
          </p>
        )}
        {loading ? (
          <p className="muted">載入中…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">目前尚無前台使用者編號紀錄。</p>
        ) : (
          <>
          <div
            className="admin-accounts-filter-row"
            style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}
          >
            <label className="admin-accounts-school-filter">
              依學校篩選：
              <select value={schoolFilter} onChange={(e) => setSchoolFilter(e.target.value)}>
                <option value="">全體學校</option>
                {schoolOptions.map((school) => (
                  <option key={school} value={school}>{school}</option>
                ))}
              </select>
            </label>
            <span className="muted">顯示 {visibleAccounts.length} / {accounts.length} 筆</span>
          </div>
          <div className="admin-table-wrap admin-accounts-table-wrap">
            <table className="admin-accounts-table">
              <colgroup>
                <col style={{ width: 180 }} />
                <col style={{ width: 220 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 190 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>編號</th>
                  <th>學生名稱</th>
                  <th title="學校 / 年級（來自學生學籍資料）">學校 / 年級</th>
                  <th>登入方式</th>
                  <th title="作業系統 / 裝置類型 / 瀏覽器">裝置環境</th>
                  <th title="IP 位址 / 裝置連線">網路連線</th>
                  <th title="風險標記 / 封鎖狀態 / 目前狀態">狀態燈號</th>
                  <th>最後上線</th>
                  <th className="admin-accounts-col-management">管理</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.map((a) => {
                  const risk = RISK_META[a.riskLevel] ?? RISK_META.safe;
                  const busy = busyId === a.sessionId;
                  const blockedTitle = a.isBlocked
                    ? `封鎖：已封鎖${a.blockedReason ? ` (${a.blockedReason})` : ""}`
                    : "封鎖：正常";
                  return (
                    <tr key={a.sessionId}>
                      <td title={a.id}>
                        <code className="admin-session-id">{a.id}</code>
                      </td>
                      <td title={a.name}>{a.name}</td>
                      <td className="admin-school-grade-cell">
                        <div
                          className="admin-school-grade"
                          title={`${a.schoolName ?? "未填寫"} / ${a.gradeLevel ?? "—"}`}
                        >
                          <span>{a.schoolName?.trim() || "未填寫"}</span>
                          <span className="muted">{a.gradeLevel?.trim() || "—"}</span>
                        </div>
                      </td>
                      <td title={a.loginMethod}>{a.loginMethod}</td>
                      <td className="admin-device-env-cell">
                        <div
                          className="admin-device-env"
                          title={`${a.osName} / ${a.deviceType} / ${a.browserName}`}
                        >
                          <span>{osIcon(a.osName)} {a.osName}</span>
                          <span>{deviceIcon(a.deviceType)} {a.deviceType}</span>
                          <span>🌐 {a.browserName}</span>
                        </div>
                      </td>
                      <td className="admin-network-cell">
                        <div
                          className="admin-network-inner"
                          title={`${a.ipAddress ?? "—"} / ${a.ipLocation}`}
                        >
                          <span><code>{a.ipAddress ?? "—"}</code></span>
                          <span className="muted">{a.ipLocation}</span>
                        </div>
                      </td>
                      <td>
                        <div className="admin-status-lights">
                          <span
                            className={`admin-status-dot ${risk.dot}`}
                            title={`風險：${risk.label}`}
                          />
                          <span
                            className={`admin-status-dot ${a.isBlocked ? "red" : "green"}`}
                            title={blockedTitle}
                          />
                          <span
                            className={`admin-status-dot ${a.online ? "green" : "gray"}`}
                            title={`上線：${a.online ? "在線" : "離線"}`}
                          />
                        </div>
                      </td>
                      <td className="muted" title={formatTime(a.lastSeenAt)}>
                        {formatTime(a.lastSeenAt)}
                      </td>
                      <td className="admin-accounts-col-management">
                        <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <select
                            value={a.riskLevel}
                            disabled={busy}
                            style={{ minWidth: 0, flex: "1 1 0" }}
                            onChange={(e) => onChangeRisk(a, e.target.value as RiskLevel)}
                          >
                            {RISK_OPTIONS.map((lvl) => (
                              <option key={lvl} value={lvl}>
                                {RISK_META[lvl].label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className={`btn ${a.isBlocked ? "secondary" : ""}`}
                            disabled={busy}
                            onClick={() => onToggleBlock(a)}
                          >
                            {a.isBlocked ? "解除" : "封鎖"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          說明：匿名帳戶以前台對話 session 為單位推算；IP、裝置、作業系統與瀏覽器由後端依
          request 解析並持久化（不信任前端傳值）。本機或私有 IP 顯示「Localhost / Private IP」。
          風險標記分為安全 / 注意 / 高風險；封鎖後，該 session 及相同公開 IP 的前台請求會被拒絕。
        </p>
      </AdminCard>
      <AdminCard title={`已註冊學生學籍名冊（${visibleStudentUsers.length}）`}>
        {visibleStudentUsers.length === 0 ? (
          <p className="muted">
            {schoolFilter
              ? `所選學校「${schoolFilter}」尚無已註冊學生。`
              : "目前尚無已註冊學生學籍資料。"}
          </p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-accounts-table">
              <thead>
                <tr>
                  <th>學生名稱</th>
                  <th>學校</th>
                  <th>年級</th>
                  <th>Email</th>
                  <th>學籍狀態</th>
                  <th>建立時間</th>
                </tr>
              </thead>
              <tbody>
                {visibleStudentUsers.map((u) => (
                  <tr key={u.id}>
                    <td title={u.displayName}>{u.displayName}</td>
                    <td>{u.schoolName?.trim() || "未填寫"}</td>
                    <td>{u.gradeLevel?.trim() || "—"}</td>
                    <td title={u.email}>{u.email}</td>
                    <td>{u.profileCompleted ? "已完成" : "未完成"}</td>
                    <td className="muted" title={formatTime(u.createdAt)}>{formatTime(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
