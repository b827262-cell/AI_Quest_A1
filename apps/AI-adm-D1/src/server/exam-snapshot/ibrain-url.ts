import { EXAM_COURSE_SOURCE_HOSTS_V1 } from "@ai-smartbook/contracts";

/** Validate every URL before issuing a request, including redirect targets. */
export function resolveIbrainUrl(href: string, base?: string): string {
  if (!href.trim()) throw new Error("missing URL");
  const url = new URL(href, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported URL protocol");
  if (!EXAM_COURSE_SOURCE_HOSTS_V1.includes(url.hostname as (typeof EXAM_COURSE_SOURCE_HOSTS_V1)[number])) {
    throw new Error(`off-whitelist host: ${url.hostname}`);
  }
  if (url.username || url.password || url.port) throw new Error("invalid source URL authority");
  return url.href;
}
