import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAppearance } from "../../appearance";
import { useAdminAuth } from "../../admin-auth";

/** Sticky white top bar: hamburger, configurable brand (name + logo), home. */
export function AdminTopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { settings } = useAppearance();
  const { user, logout } = useAdminAuth();
  const [logoFailed, setLogoFailed] = useState(false);

  // Reset the logo error state when the URL changes so a new valid logo shows.
  useEffect(() => setLogoFailed(false), [settings.headerLogoUrl]);

  const showLogo = !!settings.headerLogoUrl && !logoFailed;

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
        <span className="admin-identity-name">{user?.username ?? "管理者"}</span>
        <span className="admin-avatar" title="管理者" aria-label="管理者">
          {(user?.username?.slice(0, 1) || "管").toUpperCase()}
        </span>
        <button type="button" className="admin-btn secondary admin-logout" onClick={() => void logout()}>
          登出
        </button>
      </div>
    </header>
  );
}
