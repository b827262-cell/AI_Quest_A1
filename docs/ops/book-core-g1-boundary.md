# book-core G1 boundary enforcement

book-core may depend on its own interfaces and schema, not the ai/db
implementation packages. The old WARN exception is retired after issue #49
stages 1/2. G1 enforcement is independent of browser/server boundary checks;
existing browser, provider-endpoint and deployment checks remain in place.

## Run locally

```bash
pnpm install --frozen-lockfile
bash scripts/boundary-check.sh
node --test scripts/boundary-check.test.mjs
```

The first check must print `GATE_STATUS: PASS` and exit 0 on clean main. Any G1
violation prints `FAIL (G1)`, ends with `GATE_STATUS: FAIL`, and exits 1. Missing
parser/config or syntax/scan errors cannot silently pass. Use the repository's
pinned TypeScript version; the shell script uses its native compiler API locally.

The standalone test file is needed because no existing test directly exercised
`boundary-check.sh`. It reuses the Node `node:test` / `node:assert` mechanism
already used elsewhere in the repository and adds no framework or dependency.
Run it as shown above in addition to the existing release gate, which already
runs the boundary script. No production service or credentials are required.

## Four required negative cases

Each case gets a fresh disposable fixture and invokes the real shell script:

| Case | Mutation | Expected |
| --- | --- | --- |
| A | Add ai to book-core package.json dependencies | exit 1; FAIL (G1); GATE_STATUS: FAIL |
| B | Add a source type import from db | exit 1; FAIL (G1); GATE_STATUS: FAIL |
| C | Re-export ai from source | exit 1; FAIL (G1); GATE_STATUS: FAIL |
| D | Dynamically import db from source | exit 1; FAIL (G1); GATE_STATUS: FAIL |

The clean fixture must exit 0/PASS. Additional cases cover db declarations,
dev/peer/optional dependencies, aliases, require, import-equals and type queries,
test files, multiline/subpath/escaped literals, constant concatenation, computed
loads, relative imports, direct/inherited tsconfig paths, project references,
source symlinks and parser/config failures. Safe comments and JSONC remain valid.
The fixture script changes no working-tree source, dependencies or lockfile.

## Static policy

Both source and tests are scanned, including TS/JS module variants. Direct
ai/db package names and their subpaths are blocked. Relative paths and matched
tsconfig wildcard aliases resolving into packages/ai or packages/db are also
blocked. Config inheritance is inspected with paths relative to its defining
configuration and baseUrl. Package and directory symlinks are canonicalized.

Keep adapters at the application composition boundary. Do not satisfy tests by
adding ai/db back as a test-only or type-only dependency. Examples in dated review
reports describe historical states; this runbook and ADR-002 define current G1.
