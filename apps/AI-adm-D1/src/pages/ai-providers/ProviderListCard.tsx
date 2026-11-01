import { AdminCard } from "../../components/admin/AdminCard";
import { PROVIDER_LABELS, type Provider } from "./types";

export function ProviderListCard({
  providers,
  busy,
  onSelect,
  onDelete
}: {
  providers: Provider[];
  busy: boolean;
  onSelect: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
}) {
  return <AdminCard title="Provider 清單">
    {providers.length === 0 ? <p className="muted">目前尚未建立 Provider，請先新增一個。</p> : <div className="admin-table-wrap">
      <table className="admin-table-compact">
        <thead><tr><th>Provider</th><th>Model</th><th>Priority</th><th>狀態</th><th>路由角色</th><th>操作</th></tr></thead>
        <tbody>{providers.map((provider) => <tr key={provider.id}>
          <td><strong>{provider.displayName}</strong><br /><span className="muted">{PROVIDER_LABELS[provider.provider]} · {provider.slug}</span></td>
          <td>{provider.model || "—"}</td>
          <td>{provider.priority}</td>
          <td>{provider.enabled ? "Enabled" : "Disabled"}</td>
          <td>{provider.isDefault ? "Default " : ""}{provider.isRouterProvider ? "Router" : ""}{!provider.isDefault && !provider.isRouterProvider ? "—" : ""}</td>
          <td><div className="admin-action-row admin-action-row-tight">
            <button type="button" className="admin-btn secondary" onClick={() => onSelect(provider)} disabled={busy}>編輯／管理 Key</button>
            <button type="button" className="admin-btn danger" onClick={() => void onDelete(provider)} disabled={busy}>刪除</button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </AdminCard>;
}
