import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const config = JSON.parse(readFileSync(join(root, "lint.config.json"), "utf8"));
const scopeArg = process.argv.find((arg) => arg.startsWith("--scope="))?.slice("--scope=".length) ?? ".";
const scope = resolve(process.cwd(), scopeArg);
const extensions = new Set([".ts", ".tsx"]);
const ignoredDirectories = new Set(["node_modules", "dist", "dist-server", "legacy", ".git", ".vite"]);

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (extensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files.sort();
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function report(diagnostics, file, source, index, message) {
  diagnostics.push(`${relative(root, file)}:${lineNumber(source, index)}: ${message}`);
}

const files = collectFiles(scope);
const diagnostics = [];
const sensitiveTokens = config.security.sensitiveTokens.map((token) => token.toLowerCase());

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  if (config.typescript.noExplicitAny) {
    for (const match of source.matchAll(/(?:\b:\s*any\b|\bas\s+any\b|<any>)/g)) {
      report(diagnostics, file, source, match.index, "explicit any is not allowed; use an unknown or domain type");
    }
  }

  if (config.tests.forbidOnlyOrSkip && /\b(?:describe|it|test|suite|specify)\.(?:only|skip)\s*\(/.test(source)) {
    const match = source.match(/\b(?:describe|it|test|suite|specify)\.(?:only|skip)\s*\(/);
    report(diagnostics, file, source, match.index, "test only/skip is not allowed in the release suite");
  }

  let lineOffset = 0;
  for (const line of lines) {
    if (config.security.forbidSensitiveConsoleArguments && /\bconsole\.(?:log|warn|error|info|debug)\s*\(/.test(line)) {
      const lower = line.toLowerCase();
      if (sensitiveTokens.some((token) => lower.includes(token.toLowerCase())) || /process\.env\b/i.test(line)) {
        report(diagnostics, file, source, lineOffset, "console output may contain secret material");
      }
    }

    if (config.react.forbidObviousConditionalHooks && /\b(?:if|for|while|switch)\b[^\n{]*\buse[A-Z][A-Za-z0-9]*\s*\(/.test(line)) {
      report(diagnostics, file, source, lineOffset, "React Hook appears in an obvious conditional; move it to component top level");
    }

    if (config.promises.forbidUncaughtSingleLineThen && /\.then\s*\(/.test(line) && /;\s*$/.test(line) && !/\.catch\s*\(/.test(line) && !/^\s*void\s+/.test(line)) {
      report(diagnostics, file, source, lineOffset, "single-line Promise chain must be awaited, voided, or terminated with catch");
    }
    lineOffset += line.length + 1;
  }
}

const tsc = join(scope, "node_modules", ".bin", "tsc");
if (existsSync(tsc)) {
  const tscArgs = ["--noEmit", "--pretty", "false"];
  if (config.typescript.noUnusedLocals) tscArgs.push("--noUnusedLocals");
  if (config.typescript.noUnusedParameters) tscArgs.push("--noUnusedParameters");
  const result = spawnSync(tsc, tscArgs, {
    cwd: scope,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    diagnostics.push(...(output ? output.split("\n") : [`TypeScript lint failed with exit ${result.status}`]));
  }
} else {
  diagnostics.push(`${relative(root, scope)}: missing workspace TypeScript compiler`);
}

if (diagnostics.length) {
  console.error(`lint: ${files.length} TypeScript source files checked; ${diagnostics.length} error(s), 0 warning(s)`);
  for (const diagnostic of diagnostics) console.error(diagnostic);
  process.exitCode = 1;
} else {
  console.log(`lint: ${files.length} TypeScript source files checked; 0 error(s), 0 warning(s)`);
}
