// Node ESM loader hooks for the Cloudflare Worker bundle.
//
// vinext 1.4 emits `import * as ... from "cloudflare:workers"` in the worker
// entry, a scheme Node's default loader rejects. Tests and the local QA server
// always pass their own `env` to `worker.fetch`, so an undefined binding is
// enough to exercise the same fallback paths.
//
// These hooks live in their own module because `module.register()` loads hooks
// off-thread from a separate file. `module.registerHooks()` (in-process) only
// exists on Node >= 22.15, while site/package.json pins engines to >= 22.13.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = undefined;",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
