// Node-only test loader: the Worker bundle imports "cloudflare:workers", which
// Node's ESM loader cannot resolve. Tests pass their own env to worker.fetch, so
// an undefined `env` binding is enough to exercise the same fallback paths.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = undefined;",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
