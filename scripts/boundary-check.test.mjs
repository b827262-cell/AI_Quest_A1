import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['clean', () => {}, false],
  ['A dependency ai', f => f.package('dependencies', '@ai-smartbook/ai'), true],
  ['dependency db', f => f.package('dependencies', '@ai-smartbook/db'), true],
  ['dev dependency', f => f.package('devDependencies', '@ai-smartbook/ai'), true],
  ['peer dependency', f => f.package('peerDependencies', '@ai-smartbook/db'), true],
  ['optional dependency', f => f.package('optionalDependencies', '@ai-smartbook/ai'), true],
  ['dependency alias', f => f.package('dependencies', 'storage', 'npm:@ai-smartbook/db@*'), true],
  ['workspace alias', f => f.package('dependencies', 'storage', 'workspace:../db'), true],
  ['B source import db', f => f.source('import type { Repositories } from "@ai-smartbook/db";'), true],
  ['C re-export ai', f => f.source('export * from "@ai-smartbook/ai";'), true],
  ['D dynamic import db', f => f.source('void import("@ai-smartbook/db");'), true],
  ['require ai', f => f.source('const ai = require("@ai-smartbook/ai");'), true],
  ['import equals', f => f.source('import ai = require("@ai-smartbook/ai");'), true],
  ['import type expression', f => f.source('type P = import("@ai-smartbook/ai").AiProvider;'), true],
  ['test source', f => f.source('export { x } from "@ai-smartbook/db";', 'test'), true],
  ['multiline subpath', f => f.source('import {\n  x\n} from\n  "@ai-smartbook/ai/rag/server";'), true],
  ['escaped package name', f => f.source('void import("@ai-smartbook/\\u0061i");'), true],
  ['constant concatenation', f => f.source('void import("@ai-smartbook/" + "db");'), true],
  ['computed loading', f => f.source('void import(target);'), true],
  ['relative import', f => f.source('export * from "../../ai/src/index";'), true],
  ['tsconfig paths', f => f.config({ compilerOptions: { paths: { '@storage/*': ['../db/*'] } } }), true],
  ['configDir paths into ai declaration and alias import', f => {
    f.config({ compilerOptions: { paths: { '@local/*': ['${configDir}/../ai/*'] } } });
    f.source('export * from "@local/src/index";');
  }, true, { specifier: '@local/src/index', target: 'packages/ai/src/index.ts' }],
  ['configDir paths into db declaration and alias import', f => {
    f.config({ compilerOptions: { paths: { '@store/*': ['${configDir}/../db/*'] } } });
    f.source('export * from "@store/src/index";');
  }, true, { specifier: '@store/src/index', target: 'packages/db/src/index.ts' }],
  ['configDir baseUrl into ai and alias import', f => {
    f.config({ compilerOptions: { baseUrl: '${configDir}/../ai' } });
    f.source('export { ready } from "src/index";');
  }, true],
  ['configDir paths inherited from an extended config', f => {
    f.write('packages/config/tsconfig.paths.json', JSON.stringify({ compilerOptions: { paths: { '@shared/*': ['${configDir}/../ai/*'] } } }));
    f.config({ extends: '../config/tsconfig.paths.json' });
    f.source('export * from "@shared/src/index";');
  }, true, { specifier: '@shared/src/index', target: 'packages/ai/src/index.ts' }],
  ['configDir path outside blocked roots follows TypeScript resolution', f => {
    f.write('ai/src/index.ts', 'export const ready = true;');
    f.config({ compilerOptions: { paths: { '@outside/*': ['${configDir}/../../ai/*'] } } });
    f.source('export { ready } from "@outside/src/index";');
  }, false, { specifier: '@outside/src/index', target: 'ai/src/index.ts' }],
  ['tsconfig references', f => f.config({ references: [{ path: '../ai' }] }), true],
  ['inherited paths', f => {
    f.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@storage/*': ['packages/db/*'] } } }));
    f.config({ extends: '../../tsconfig.base.json' });
  }, true],
  ['broad wildcard alias import', f => {
    f.config({ compilerOptions: { paths: { '@local/*': ['../*'] } } });
    f.source('export * from "@local/ai/src/index";');
  }, true],
  ['source symlink', f => symlinkSync(path.join(f.root, 'packages/ai'), path.join(f.root, 'packages/book-core/src/hidden')), true],
  ['src root symlink', f => {
    rmSync(path.join(f.root, 'packages/book-core/src'), { recursive: true });
    symlinkSync(path.join(f.root, 'packages/ai/src'), path.join(f.root, 'packages/book-core/src'), 'dir');
  }, true],
  ['test root symlink', f => {
    rmSync(path.join(f.root, 'packages/book-core/test'), { recursive: true });
    symlinkSync(path.join(f.root, 'packages/db/src'), path.join(f.root, 'packages/book-core/test'), 'dir');
  }, true],
  ['package root index is scanned', f => f.write('packages/book-core/index.ts', 'export * from "@ai-smartbook/ai";'), true],
  ['package scripts are scanned', f => f.write('packages/book-core/scripts/probe.mjs', 'export * from "@ai-smartbook/db";'), true],
  ['package dist is excluded from source scan', f => f.write('packages/book-core/dist/probe.ts', 'export * from "@ai-smartbook/ai";'), false],
  ['missing compiler fails closed', f => unlinkSync(path.join(f.root, 'packages/book-core/node_modules')), true],
  ['invalid tsconfig', f => f.write('packages/book-core/tsconfig.json', '{'), true],
  ['comments are not imports', f => f.source('// import x from "@ai-smartbook/ai";\nconst example = "@ai-smartbook/db";'), false],
  ['safe JSONC', f => f.write('packages/book-core/tsconfig.json', '{ /* comment */ "compilerOptions": { "module": "ESNext", }, "include": ["src", "test",], }'), false]
];

for (const [name, mutate, mustFail, tsResolution] of cases) {
  test(`G1 ${name}`, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'a01-boundary-test-'));
    const write = (file, text) => {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    };
    const pkg = { name: '@ai-smartbook/book-core', type: 'module' };
    const config = { compilerOptions: { module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler' }, include: ['src', 'test'] };
    try {
      for (const dir of ['apps/AI-Stu-R1/src', 'packages/student-runtime/src', 'packages/ai/src', 'packages/db/src', 'packages/book-core/src', 'packages/book-core/test', 'scripts']) mkdirSync(path.join(root, dir), { recursive: true });
      write('packages/book-core/package.json', JSON.stringify(pkg));
      write('packages/book-core/tsconfig.json', JSON.stringify(config));
      write('packages/book-core/src/index.ts', 'export const ready = true;');
      write('packages/ai/src/index.ts', 'export const ready = true;');
      write('packages/db/src/index.ts', 'export const ready = true;');
      write('deploy/systemd/student.env.example', '');
      copyFileSync(path.join(repo, 'scripts/boundary-check.sh'), path.join(root, 'scripts/boundary-check.sh'));
      symlinkSync(path.join(repo, 'packages/book-core/node_modules'), path.join(root, 'packages/book-core/node_modules'), 'dir');
      mutate({ root, write,
        source: (text, dir = 'src') => write(`packages/book-core/${dir}/probe.ts`, text),
        package: (section, name, version = 'workspace:*') => {
          pkg[section] = { [name]: version };
          write('packages/book-core/package.json', JSON.stringify(pkg));
        },
        config: patch => write('packages/book-core/tsconfig.json', JSON.stringify({ ...config, ...patch }))
      });
      const result = spawnSync('bash', ['scripts/boundary-check.sh'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
      const output = result.stdout + result.stderr;
      assert.ifError(result.error);
      assert.equal(result.signal, null, output);
      if (mustFail) {
        assert.equal(result.status, 1, output);
        assert.match(output, /FAIL \(G1\):/);
        assert.match(output, /GATE_STATUS: FAIL/);
        assert.doesNotMatch(output, /GATE_STATUS: PASS/);
      } else {
        assert.equal(result.status, 0, output);
        assert.match(output, /GATE_STATUS: PASS/);
        assert.doesNotMatch(output, /FAIL/);
      }
      if (tsResolution) {
        const require = createRequire(path.join(repo, 'packages/book-core/package.json'));
        const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
        const trace = spawnSync(process.execPath, [tsc, '--noEmit', '--traceResolution', '-p', 'packages/book-core/tsconfig.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
        const traceOutput = trace.stdout + trace.stderr;
        assert.ifError(trace.error);
        assert.equal(trace.signal, null, traceOutput);
        assert.equal(trace.status, 0, traceOutput);
        assert.ok(traceOutput.includes(path.join(root, tsResolution.target)), traceOutput);
        assert.ok(traceOutput.includes(`Module name '${tsResolution.specifier}' was successfully resolved to`), traceOutput);
      }
      if (/^[ABCD] /.test(name) || name === 'clean') t.diagnostic(`${name}: exit=${result.status}\n${output.trim()}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
