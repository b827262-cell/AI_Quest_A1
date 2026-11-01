import { Link } from "react-router-dom";
import { displayBrand } from "../../display-brand";
import type { PublicSiteConfig } from "../../studentClient";

function BrandMark() {
  return (
    <span className="public-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12.5 6.5a5 5 0 0 0-5 5v.6A4.2 4.2 0 0 0 5 16c0 1.4.7 2.7 1.8 3.5a5 5 0 0 0 4.7 5.2h2V6.5Z" />
        <path d="M19.5 6.5a5 5 0 0 1 5 5v.6A4.2 4.2 0 0 1 27 16c0 1.4-.7 2.7-1.8 3.5a5 5 0 0 1-4.7 5.2h-2V6.5Z" />
        <path d="M12 12h2M12 16h2M18 12h2M18 16h2M16 6v20" />
      </svg>
    </span>
  );
}

export function PublicHomeHeader({ config, studentName }: { config: PublicSiteConfig; studentName: string }) {
  const siteTitle = displayBrand(config.siteTitle);
  return (
    <header className="public-home-header">
      <Link to="/" className="public-brand-link" aria-label={`${siteTitle} 首頁`}>
        <BrandMark />
        <span>{siteTitle}</span>
      </Link>
      <nav className="public-home-nav" aria-label="公開首頁導覽">
        <a href="#features">功能介紹</a>
        {studentName ? <span className="public-welcome-chip">嗨，{studentName}</span> : null}
        {config.studentLoginEnabled ? (
          <Link className="public-login-button" to="/login">
            {studentName ? "學習首頁" : "學員登入"}
          </Link>
        ) : null}
      </nav>
    </header>
  );
}
