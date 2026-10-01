// This module is deliberately loaded only by the browser worker seam below.
// Vite owns the `?worker` transform, so the constructor it exports creates an
// origin-relative worker URL instead of deriving one from vinext's serialized
// `import.meta.url` source path.
import LocalInferenceWorker from "./local-inference.worker.ts?worker";

export function createLocalInferenceWorker(): Worker {
  return new LocalInferenceWorker({ name: "local-inference" });
}
