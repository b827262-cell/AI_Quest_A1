import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // vinext 1.4 otherwise 308-redirects "/api/health/"; the runbook and the
  // topology tests treat it as an observable alias of "/api/health".
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
