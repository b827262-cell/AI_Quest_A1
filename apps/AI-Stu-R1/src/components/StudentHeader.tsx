import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAppearance } from "../appearance";
import { UserMenuDropdown } from "./UserMenuDropdown";
import { useStudentAuth } from "../student-auth";

function BrainIcon({ size }: { size: number }) {
  return (
    <span className="header-icon brand" aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9.5 4.5a3.5 3.5 0 0 0-3.5 3.5v.5A3 3 0 0 0 4 11.5c0 1 .48 1.9 1.22 2.45A3.5 3.5 0 0 0 8.5 19h1V4.5Z" />
        <path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v.5a3 3 0 0 1 2 3c0 1-.48 1.9-1.22 2.45A3.5 3.5 0 0 1 15.5 19h-1V4.5Z" />
        <path d="M9 9.5h1.5M9 13h1.5M13.5 9.5H15M13.5 13H15M12 4v15" />
      </svg>
    </span>
  );
}

function HomeIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" width={size} height={size} aria-hidden="true">
      <path d="m4 11 8-6 8 6" />
      <path d="M6.5 10.5V19h11v-8.5" />
    </svg>
  );
}

/** Brand logo: configured image with fallback to the built-in brain icon. */
function BrandLogo({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (url && !failed) {
    return (
      <img
        className="brand-logo-img"
        src={url}
        alt=""
        style={{ width: size, height: size, objectFit: "contain", borderRadius: 8 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <BrainIcon size={size} />;
}

/** Home button icon: built-in or custom image (falls back to built-in). */
function HomeButtonIcon({ mode, url, size }: { mode: string; url: string; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (mode === "image" && url && !failed) {
    return (
      <img src={url} alt="" style={{ width: size, height: size, objectFit: "contain" }} onError={() => setFailed(true)} />
    );
  }
  return <HomeIcon size={size} />;
}

function CoinIcon() {
  return (
    <span className="coin-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="7" />
        <path d="M10 9.5h4M9.5 12h5M10 14.5h4" />
      </svg>
    </span>
  );
}

export function StudentHeader() {
  const a = useAppearance();
  const { profile, logout, status } = useStudentAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const studentName = profile?.displayName.trim() || "學員";
  const points = 0;
  const initial = studentName.charAt(0).toUpperCase() || "學";

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function handleLogout() {
    void logout();
  }

  return (
    <header
      className="student-header"
      style={{
        background: a.studentHeaderBackgroundColor,
        borderBottom: `1px solid ${a.studentHeaderBorderColor}`,
        boxShadow: a.studentHeaderShadowEnabled ? "0 6px 18px rgba(20,34,53,0.08)" : "none"
      }}
    >
      <div className="student-header-inner">
        <Link className="brand-link" to="/books" style={{ gap: a.studentHeaderBrandGap }}>
          <BrandLogo url={a.studentHeaderBrandLogoUrl} size={a.studentHeaderBrandLogoSize} />
          <span style={{ color: a.studentHeaderBrandTextColor, fontSize: a.studentHeaderBrandFontSize }}>
            {a.studentHeaderBrandText}
          </span>
        </Link>

        <Link
          className="home-pill"
          to="/books"
          style={{
            background: a.studentHeaderHomeButtonBg,
            color: a.studentHeaderHomeButtonTextColor,
            borderRadius: a.studentHeaderHomeButtonRadius,
            height: a.studentHeaderHomeButtonHeight,
            padding: `0 ${a.studentHeaderHomeButtonHorizontalPadding}px`
          }}
        >
          <HomeButtonIcon
            mode={a.studentHeaderHomeButtonIconMode}
            url={a.studentHeaderHomeButtonIconUrl}
            size={a.studentHeaderHomeButtonIconSize}
          />
          <span>{a.studentHeaderHomeButtonLabel}</span>
        </Link>

        <div className="student-user-area" ref={menuRef}>
          <span className="student-name" title={studentName}>
            {studentName}
          </span>
          <span className="student-points">
            <CoinIcon />
            <strong>{points}</strong>
          </span>
          <button
            className="student-avatar"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            {initial}
          </button>
          <UserMenuDropdown
            open={menuOpen}
            name={studentName}
            points={points}
            canLogout={status === "authenticated"}
            onLogout={handleLogout}
          />
        </div>
      </div>
    </header>
  );
}
