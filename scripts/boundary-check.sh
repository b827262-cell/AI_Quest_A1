#!/usr/bin/env bash
# scripts/boundary-check.sh — browser/server module boundary gate.
#
# The rule being enforced: the student browser bundle (apps/AI-Stu-R1/src)
# may never import server-only packages (@ai-smartbook/ai, @ai-smartbook/db)
# or talk to an LLM provider directly. The student server/ directory is the
# only place allowed to reach the RAG/AI stack.
set -uo pipefail
FAIL=0

echo "=== Module Boundary Check ==="

# --- Browser boundary -------------------------------------------------------
# Student browser bundle must not import AI or DB packages.
if grep -rn --include='*.ts' --include='*.tsx' "@ai-smartbook/ai\|@ai-smartbook/db" apps/AI-Stu-R1/src/ 2>/dev/null; then
  echo "❌ FAIL: student browser bundle imports server-only packages"
  FAIL=1
fi

# Student browser bundle must not call any LLM provider directly.
if grep -rniE --include='*.ts' --include='*.tsx' "api\.cerebras|cerebras\.ai|openai\.com|generativelanguage" apps/AI-Stu-R1/src/ 2>/dev/null; then
  echo "❌ FAIL: student browser bundle references an LLM provider endpoint"
  FAIL=1
fi

# --- Package boundaries ------------------------------------------------------
# Student runtime must not import the AI orchestration package.
if grep -rn --include='*.ts' "@ai-smartbook/ai" packages/student-runtime/src/ 2>/dev/null; then
  echo "❌ FAIL: student-runtime imports ai"
  FAIL=1
fi

# G1: book-core owns its interfaces and must not depend on ai/db implementations.
# Reuse the existing TypeScript dev dependency; no source modules are executed.
if ! node --input-type=module <<'G1_NODE'
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let failed = false;
let api, snapshot;
const fail = message => { console.error(`❌ FAIL (G1): ${message}`); failed = true; };
try {
  const root = process.cwd();
  const book = path.join(root, "packages/book-core");
  const require = createRequire(path.join(book, "package.json"));
  const ts = await import(require.resolve("typescript/unstable/ast"));
  const { API } = await import(require.resolve("typescript/unstable/sync"));
  api = new API();
  const forbidden = value => /^@ai-smartbook\/(ai|db)(?:\/|$)/.test(value);
  const configDirToken = "${configDir}";
  const expandConfigDir = (value, configDirectory) => typeof value === "string" && value.startsWith(configDirToken)
    ? `${configDirectory}${value.slice(configDirToken.length)}` : value;
  // Resolve symlink ancestors too, including workspace links under node_modules.
  const canonical = value => {
    const absolute = path.resolve(value);
    if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
  };
  const blockedRoots = ["ai", "db"].map(name => canonical(path.join(root, "packages", name)));
  const blockedPath = value => {
    const target = canonical(value.split("*")[0]);
    return blockedRoots.some(dir => target === dir || target.startsWith(dir + path.sep));
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(book, "package.json"), "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      const alias = String(version).replace(/^npm:/, "");
      const local = /^(?:workspace|file|link):(.+)$/.exec(String(version));
      if (forbidden(name) || /^@ai-smartbook\/(ai|db)(?:@|\/|$)/.test(alias)
        || (local && blockedPath(path.resolve(book, local[1])))) fail(`package.json ${section}: ${name}`);
    }
  }
  // JSONC tokenization supports comments/trailing commas without executing config.
  const jsonc = file => {
    const scan = ts.createScanner(true, undefined, fs.readFileSync(file, "utf8"));
    const tokens = [];
    while (scan.scan() !== ts.SyntaxKind.EndOfFile) {
      if (scan.isUnterminated()) throw new Error("unterminated tsconfig token");
      tokens.push(scan.getTokenText());
    }
    return JSON.parse(tokens.filter((t, i) => !(t === "," && ["}", "]"].includes(tokens[i + 1]))).join(""));
  };
  const loadConfig = (file, ancestors = new Set()) => {
    file = canonical(file);
    if (ancestors.has(file)) throw new Error("tsconfig extends cycle");
    const next = new Set([...ancestors, file]);
    const config = jsonc(file);
    let inherited = {};
    for (const parent of typeof config.extends === "string" ? [config.extends] : config.extends ?? []) {
      let target = parent.startsWith(".") || path.isAbsolute(parent)
        ? path.resolve(path.dirname(file), parent)
        : createRequire(file).resolve(parent);
      if (!fs.existsSync(target) && fs.existsSync(target + ".json")) target += ".json";
      if (fs.statSync(target).isDirectory()) target = path.join(target, "tsconfig.json");
      if (blockedPath(target)) fail("tsconfig extends an ai/db config");
      inherited = { ...inherited, ...loadConfig(target, next) };
    }
    const options = config.compilerOptions ?? {};
    for (const ref of config.references ?? []) {
      if (blockedPath(path.resolve(path.dirname(file), ref.path))) fail("tsconfig references an ai/db project");
    }
    return {
      ...inherited,
      ...(options.baseUrl === undefined ? {} : {
        baseUrl: path.resolve(path.dirname(file), expandConfigDir(options.baseUrl, path.dirname(file)))
      }),
      ...(options.paths === undefined ? {} : { paths: options.paths, pathsBase: path.dirname(file) })
    };
  };
  const configFile = path.join(book, "tsconfig.json");
  api.parseConfigFile(configFile); // Let the installed compiler validate options too.
  const config = loadConfig(configFile);
  const pathsConfigDir = config.pathsBase || book;
  const pathsBase = config.baseUrl || pathsConfigDir;
  const resolvePathTarget = target => path.resolve(pathsBase, expandConfigDir(target, pathsConfigDir));
  for (const [alias, targets] of Object.entries(config.paths ?? {})) {
    if (forbidden(alias) || targets.some(target => forbidden(target) || blockedPath(resolvePathTarget(target)))) {
      fail(`tsconfig paths: ${alias}`);
    }
  }
  const aliasedToBlockedPath = specifier => Object.entries(config.paths ?? {}).some(([alias, targets]) => {
    const star = alias.indexOf("*");
    const capture = star < 0 ? (specifier === alias ? "" : null)
      : specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1))
        ? specifier.slice(star, alias.length === star + 1 ? undefined : -(alias.length - star - 1)) : null;
    return capture !== null && targets.some(target => blockedPath(resolvePathTarget(target.replace("*", capture))));
  });
  const files = [];
  const excludedDirectories = new Set(["node_modules", "dist"]);
  const walk = dir => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`source symlink is not allowed: ${path.relative(root, dir)}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (excludedDirectories.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${path.relative(root, file)}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  };
  walk(book);
  snapshot = api.updateSnapshot({ openFiles: files });
  const constantString = node => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
    if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = constantString(node.left), b = constantString(node.right);
      return a !== null && b !== null ? a + b : null;
    }
    return null;
  };
  const inspect = file => {
    const project = snapshot.getDefaultProjectForFile(file);
    const source = project?.program.getSourceFile(file);
    if (!source || project.program.getSyntacticDiagnostics(file).length) throw new Error(`source parse error: ${path.relative(root, file)}`);
    const check = (node, expression) => {
      const specifier = constantString(expression);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const location = `${path.relative(root, file)}:${line}`;
      if (specifier === null) { fail(`${location}: computed module loading is not allowed`); return; }
      if (forbidden(specifier)
        || (specifier.startsWith(".") && blockedPath(path.resolve(path.dirname(file), specifier)))
        || (path.isAbsolute(specifier) && blockedPath(specifier))
        || aliasedToBlockedPath(specifier)
        || (config.baseUrl && blockedPath(path.resolve(config.baseUrl, specifier)))) fail(`${location}: forbidden module ${specifier}`);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node, node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) check(node, node.moduleReference.expression);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node, node.argument.literal);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(callee) && callee.text === "require")
          || (ts.isPropertyAccessExpression(callee) && (callee.name.text === "require"
            || (ts.isIdentifier(callee.expression) && callee.expression.text === "require" && callee.name.text === "resolve")));
        if (isLoader) {
          if (!node.arguments.length) fail(`${path.relative(root, file)}: module loading without a specifier`);
          else check(node, node.arguments[0]);
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  };
  for (const file of files) inspect(file);
} catch (error) {
  fail(`unable to complete isolation check: ${error.message}`);
} finally {
  snapshot?.dispose();
  api?.close();
}
process.exitCode = failed ? 1 : 0;
G1_NODE
then
  FAIL=1
fi

# --- Deployment hygiene -------------------------------------------------------
# No API keys shipped in the student deployment template.
if grep -rI "API_KEY" deploy/systemd/student.env.example 2>/dev/null; then
  echo "❌ FAIL: student.env has API_KEY"
  FAIL=1
fi

# Forbidden infrastructure tech in first-party sources (word-boundary match so
# words like "redistribute" cannot trigger the redis rule).
FORBIDDEN_SOURCES=$(find apps/*/src apps/*/server packages/*/src scripts -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \) 2>/dev/null)
if echo "$FORBIDDEN_SOURCES" | xargs grep -rniEw 'mysql|docker|pm2|redis' 2>/dev/null; then
  echo "❌ FAIL: forbidden tech reference found"
  FAIL=1
fi

if [ $FAIL -eq 0 ]; then
  echo "✅ All boundary checks passed"
  echo "GATE_STATUS: PASS"
else
  echo "❌ Boundary violations detected"
  echo "GATE_STATUS: FAIL"
fi
exit $FAIL
