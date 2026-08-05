import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppearance } from "../../appearance";
import { useAdminAuth } from "../../adminAuth";

const ADMIN_IDENTITY = { org: "admin", initial: "管", label: "管理者" };

/** Sticky white top bar: hamburger, configurable brand, home and logout. */
export function AdminTopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { settings } = useAppearance();
  const { logout } = useAdminAuth();
  const navigate = useNavigate();
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => setLogoFailed(false), [settings.headerLogoUrl]);

  const showLogo = !!settings.headerLogoUrl && !logoFailed;
  const handleLogout = () => {
    logout();
    navigate("/admin/login", { replace: true });
  };

  return (
    <header className="admin-topbar">
      <div className="admin-topbar-left">
        <button
          type="button"
          className="admin-hamburger"
          onClick={onToggleSidebar}
          aria-label="切換側邊選單"
        >
          ☰
        </button>
        <Link to="/admin" className="admin-brand" style={{ gap: `${settings.headerLogoTextGap}px` }}>
          {showLogo ? (
            <img
              className="admin-brand-logo"
              src={settings.headerLogoUrl}
              alt={settings.systemName}
              style={{ width: settings.headerLogoSize, height: settings.headerLogoSize }}
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span
              className="admin-brand-mark"
              style={{ width: settings.headerLogoSize, height: settings.headerLogoSize }}
            >
              iB
            </span>
          )}
          <span>{settings.systemName}</span>
        </Link>
      </div>

      <Link to="/admin" className="admin-topbar-home">
        首頁
      </Link>

      <div className="admin-topbar-right">
        <span className="admin-identity-name">{ADMIN_IDENTITY.org}</span>
        <span className="admin-avatar" title={ADMIN_IDENTITY.label} aria-label={ADMIN_IDENTITY.label}>
          {ADMIN_IDENTITY.initial}
        </span>
        <button
          type="button"
          className="admin-btn ghost"
          onClick={handleLogout}
          aria-label="登出管理後台"
          style={{ padding: "7px 12px", whiteSpace: "nowrap" }}
        >
          登出
        </button>
      </div>
    </header>
  );
}
