import { useCallback, useEffect, useState } from "react";
import { http } from "../api-transport";
import { useConfirm } from "../components/useConfirm";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AdminCard } from "../components/admin/AdminCard";

type Row = { id: string; email: string; status: "active" | "disabled"; note: string | null; lastUsedAt: string | null };
const BASE = "/api/admin/student-passcodes";
export function StudentPasscodesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const confirm = useConfirm();
  const load = useCallback(async () => { const result = await http<{ passcodes: Row[] }>(BASE); setRows(result.passcodes); }, []);
  useEffect(() => { void load().catch(() => setError("無法載入學生通行碼")); }, [load]);
  async function issue(path: string, body?: object) {
    setError("");
    try {
      const result = await http<{ passcode: string }>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      setSecret(result.passcode); setEmail(""); setNote(""); await load();
    } catch { setError("操作失敗，請確認資料後重試。"); }
  }
  async function reset(row: Row) {
    if (!await confirm({ title: "重設通行碼", message: `確定重設 ${row.email} 的通行碼？所有已登入的裝置都將登出。`, tone: "danger" })) return;
    await issue(`${BASE}/${encodeURIComponent(row.id)}/reset`);
  }
  async function changeStatus(row: Row) {
    const status = row.status === "active" ? "disabled" : "active";
    if (status === "disabled" && !await confirm({ title: "停用通行碼", message: `確定停用 ${row.email} 的通行碼？`, tone: "danger" })) return;
    try { await http(`${BASE}/${encodeURIComponent(row.id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); await load(); }
    catch { setError("操作失敗，請稍後重試。"); }
  }
  return <section><h1>學生通行</h1>{error && <p role="alert">{error}</p>}
    <AdminCard title="新增學生通行碼">
      <form className="admin-filter-row" onSubmit={(event) => { event.preventDefault(); void issue(BASE, { email, note }); }}>
        <label>電子郵件<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>備註<input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></label>
        <button className="admin-btn" type="submit">新增通行碼</button>
      </form>
    </AdminCard>
    <AdminCard title="學生通行碼">
      <div className="admin-table-wrap"><table className="admin-accounts-table">
        <thead><tr><th>電子郵件</th><th>狀態</th><th>備註</th><th>管理</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}><td>{row.email}</td><td>{row.status === "active" ? "啟用" : "停用"}</td><td>{row.note ?? "—"}</td><td>
          <button className="admin-btn secondary" type="button" onClick={() => void reset(row)}>重設</button>{" "}
          <button className="admin-btn secondary" type="button" onClick={() => void changeStatus(row)}>{row.status === "active" ? "停用" : "啟用"}</button>
        </td></tr>)}</tbody>
      </table></div>
    </AdminCard>
    <ConfirmDialog open={Boolean(secret)} title="學生通行碼" message={<><p>{secret}</p><p>關閉後無法再查看</p><button className="admin-btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(secret)}>複製</button></>} cancelLabel={null} confirmLabel="關閉" onConfirm={() => setSecret("")} onCancel={() => setSecret("")} />
  </section>;
}
