import targets from "../deploy/targets.json";

export type SiteBuildEnv = { SITE_ROLE: string; SITE_NAME: string; PRIMARY_ORIGIN: string; GIT_SHA: string };

/** Only explicitly selected, validated public topology values may enter a build. */
export function resolveSiteBuildEnv(target: string | undefined, sha: string | undefined, declarations: typeof targets.targets = targets.targets): SiteBuildEnv | null {
  if (target === undefined) return null;
  if (target !== "backend" && target !== "student" && target !== "admin") throw new Error("SITE_TARGET must be backend, student or admin");
  if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error("GIT_SHA must be a full 40-character hexadecimal commit SHA");
  const config = declarations[target];
  if (config.site !== target || config.role !== (target === "backend" ? "primary" : "secondary")) throw new Error("Invalid site target declaration");
  const origin = config.primary_origin;
  if (target === "backend") {
    if (origin !== null) throw new Error("Primary target must not specify a primary origin");
  } else {
    if (!origin) throw new Error("Secondary target requires a primary origin");
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("Invalid primary origin"); }
    if (parsed.protocol !== "https:" || parsed.origin !== origin.replace(/\/$/, "")) throw new Error("Invalid primary origin");
  }
  return { SITE_ROLE: config.role, SITE_NAME: config.site, PRIMARY_ORIGIN: origin ?? "", GIT_SHA: sha.toLowerCase() };
}
