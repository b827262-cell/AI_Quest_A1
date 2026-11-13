// Security test fixtures - SSRF local test stub URLs.
// Only 127.0.0.1 and localhost are used. No real external URLs.

export const SSRF_STUB_URLS = [
  "http://127.0.0.1:5174/api/admin/health",
  "http://127.0.0.1:5174/api/admin/auth/me",
  "http://localhost:5174/api/admin/health",
  "http://127.0.0.1:3000/api/admin/courses",
  "http://[::1]:5174/api/admin/health"
];

export const SSRF_BLOCKED_URLS = [
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.1:8080/internal",
  "https://attacker.example.invalid/webhook",
  "http://192.168.1.1/admin",
  "http://metadata.google.internal/"
];

export function isLocalOnly(url) {
  return /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])/.test(url);
}

export function isBlocked(url) {
  return !isLocalOnly(url);
}
