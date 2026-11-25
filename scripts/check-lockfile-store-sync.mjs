import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseImporterSections(lockText) {
  const lines = lockText.split(/\r?\n/);
  const importers = new Map();
  let inImporters = false;
  let importer = null;
  let section = null;
  let dependency = null;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 0) {
      inImporters = content === "importers:";
      importer = null;
      section = null;
      dependency = null;
      continue;
    }
    if (!inImporters) continue;

    if (indent === 2 && content.endsWith(":")) {
      const key = parseScalar(content.slice(0, -1));
      importer = { dependencies: new Map(), devDependencies: new Map() };
      importers.set(key, importer);
      section = null;
      dependency = null;
      continue;
    }
    if (!importer) continue;

    if (indent === 4 && (content === "dependencies:" || content === "devDependencies:")) {
      section = content.slice(0, -1);
      dependency = null;
      continue;
    }
    if (indent === 6 && content.endsWith(":") && section) {
      dependency = parseScalar(content.slice(0, -1));
      importer[section].set(dependency, "");
      continue;
    }
    if (indent === 8 && dependency && content.startsWith("version:")) {
      importer[section].set(dependency, parseScalar(content.slice("version:".length)));
    }
  }
  return importers;
}

function packageStorePrefix(packageName, version) {
  return `${packageName.replaceAll("/", "+")}@${version}`;
}

function storeEntryMatches(entry, prefix) {
  if (entry === prefix) return true;
  const suffix = entry.slice(prefix.length, prefix.length + 1);
  return entry.startsWith(prefix) && (suffix === "_" || suffix === "(");
}

export function scanLockfileStoreSync(root) {
  const lockPath = join(root, "pnpm-lock.yaml");
  const lockText = readFileSync(lockPath, "utf8");
  const versionMatch = lockText.match(/^lockfileVersion:\s*['"]?([^'"\s]+)['"]?/m);
  if (versionMatch?.[1] !== "9.0") {
    throw new Error(`Expected pnpm lockfileVersion 9.0, found ${versionMatch?.[1] ?? "missing"}`);
  }

  const importers = parseImporterSections(lockText);
  if (importers.size === 0) throw new Error("No workspace importers found in pnpm-lock.yaml");
  const storePath = join(root, "node_modules", ".pnpm");
  const storeEntries = new Set(existsSync(storePath) ? readdirSync(storePath) : []);
  const issues = [];
  let dependenciesScanned = 0;
  let dependenciesSkipped = 0;

  for (const [importerPath, importer] of importers) {
    const workspacePath = importerPath === "." ? root : join(root, importerPath);
    for (const sectionName of ["dependencies", "devDependencies"]) {
      for (const [packageName, rawVersion] of importer[sectionName]) {
        if (!rawVersion || rawVersion.startsWith("link:") || rawVersion.startsWith("workspace:")) {
          dependenciesSkipped += 1;
          continue;
        }
        dependenciesScanned += 1;
        const version = rawVersion.split("(", 1)[0];
        if (!version || version.startsWith("link:") || version.startsWith("workspace:")) {
          dependenciesSkipped += 1;
          dependenciesScanned -= 1;
          continue;
        }

        const prefix = packageStorePrefix(packageName, version);
        if (![...storeEntries].some((entry) => storeEntryMatches(entry, prefix))) {
          issues.push(`${importerPath}: store entry missing for ${packageName}@${version} (${prefix}*)`);
        }

        const installedManifest = join(workspacePath, "node_modules", packageName, "package.json");
        if (!existsSync(installedManifest)) {
          issues.push(`${importerPath}: installed package missing: node_modules/${packageName}/package.json`);
          continue;
        }
        try {
          const installedPackage = JSON.parse(readFileSync(installedManifest, "utf8"));
          if (installedPackage.version !== version) {
            issues.push(`${importerPath}: ${packageName} installed version ${installedPackage.version ?? "<missing>"} != lockfile ${version}`);
          }
        } catch (error) {
          issues.push(`${importerPath}: cannot read ${packageName} package.json (${error.message})`);
        }
      }
    }
  }

  return { importerCount: importers.size, dependenciesScanned, dependenciesSkipped, issues };
}

export function reportLockfileStoreSync(result, warnOnly = false) {
  if (result.issues.length > 0) {
    for (const issue of result.issues) console.error(`DRIFT: ${issue}`);
    console.log(`Scanned ${result.importerCount} importers; checked ${result.dependenciesScanned} dependencies; skipped ${result.dependenciesSkipped}.`);
    console.log(`RESULT: ${warnOnly ? "WARN" : "FAIL"} (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"})`);
    return warnOnly ? 0 : 1;
  }
  console.log(`Scanned ${result.importerCount} importers; checked ${result.dependenciesScanned} dependencies; skipped ${result.dependenciesSkipped}.`);
  console.log("RESULT: OK");
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const warnOnly = args.includes("--warn-only");
  const unexpected = args.filter((argument) => argument !== "--warn-only");
  if (unexpected.length > 0) {
    console.error(`Unknown argument: ${unexpected.join(" ")}`);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = reportLockfileStoreSync(scanLockfileStoreSync(DEFAULT_ROOT), warnOnly);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
