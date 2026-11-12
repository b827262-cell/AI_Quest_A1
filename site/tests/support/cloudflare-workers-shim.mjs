// Node-only test entry: registers the shared `cloudflare:workers` loader hooks.
//
// Uses `module.register()` with a separate hooks module instead of
// `module.registerHooks()`, because the latter needs Node >= 22.15 while
// site/package.json keeps engines at >= 22.13. See
// scripts/cloudflare-workers-hooks.mjs for the hook itself.
import { register } from "node:module";

register("../../scripts/cloudflare-workers-hooks.mjs", import.meta.url);
