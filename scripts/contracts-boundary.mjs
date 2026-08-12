import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserRoots = [
  resolve(repoRoot, "apps/AI-Stu-R1/src"),
  resolve(repoRoot, "apps/AI-adm-D1/src")
];

function sourceFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) {
      if (name === "server") return [];
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const forbiddenImports = [
  /@ai-smartbook\/contracts\/server/,
  /@ai-smartbook\/contracts\/src\//,
  /@ai-smartbook\/contracts\/internal/,
  /@ai-smartbook\/db/,
  /from\s+["']node:/
];
const violations = [];
for (const path of browserRoots.flatMap(sourceFiles)) {
  const source = readFileSync(path, "utf8");
  for (const pattern of forbiddenImports) {
    if (pattern.test(source)) violations.push(`${path.slice(repoRoot.length + 1)}:${pattern.source}`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "packages/contracts/package.json"), "utf8"));
const exportKeys = Object.keys(packageJson.exports ?? {}).sort();
if (JSON.stringify(exportKeys) !== JSON.stringify([".", "./browser", "./server"])) {
  violations.push(`packages/contracts/package.json:unexpected exports ${exportKeys.join(",")}`);
}

if (violations.length > 0) {
  console.error(`Contract boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log(`[contracts-boundary] PASS (${browserRoots.flatMap(sourceFiles).length} browser source files checked)`);
