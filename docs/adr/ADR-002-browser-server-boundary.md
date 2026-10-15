# ADR-002: Browser / Server Boundary

Status: Accepted

## Context

The monorepo shares packages between Vite clients and Node servers. A broad
package entry can accidentally bundle Node APIs, DB code or secret-bearing
provider configuration.

## Decision

Browser code imports only browser-safe package entries. For contracts, the
default and `/browser` entries are safe; server consumers use `/server` when
needed. Browser entries contain JSON-compatible values and pure schemas only.
They must not reference Node built-ins, DB clients, provider SDKs, environment
access or secret configuration.

## Alternatives

- Depend on tree-shaking: rejected because type/value re-exports still widen
  the supported surface and bundler behavior changes.
- Use runtime conditionals in one entry: rejected because forbidden modules are
  still resolvable from browser code.
- Duplicate browser types: rejected because drift defeats contract ownership.

## Consequences

Packages expose more explicit entry points. Server-only utilities remain
available without becoming browser API. Boundary tests become release gates.

## Migration / Enforcement

Use package `exports`, forbid deep imports and run contract plus existing Admin
client-boundary tests. New browser imports of `/server`, `@ai-smartbook/db`,
`node:*` or secret names fail review and must be removed before merge.


## G1: book-core implementation isolation (issue #49, 2026-10-14)

After repository and AI/prompt dependency inversion, book-core owns the interfaces
it consumes. Applications inject storage, providers and prompt builders. The
former ai/db known limitation is closed; reintroducing either implementation
package is a hard release-gate failure, including type-only references.

`scripts/boundary-check.sh` rejects ai/db dependency declarations (including dev,
peer, optional and local/package aliases), imports/re-exports/loaders in both
`packages/book-core/src` and `packages/book-core/test`, and tsconfig paths or
project references into ai/db. Comments and ordinary example strings are not
imports. Static concatenations and escaped literals are checked; computed
module loading that cannot be proven safe is rejected. Source symlinks and
incomplete scans also fail closed.

Run `pnpm install --frozen-lockfile` first. The check uses the existing, pinned
TypeScript 7 compiler API to read syntax; it does not execute inspected source.
No additional parser package is installed. Failure to load the parser, parse
source/config, or finish the scan is FAIL. The contract remains exit 0 plus
`GATE_STATUS: PASS`, or exit 1 plus `GATE_STATUS: FAIL`.

Run the isolated positive/negative regression suite with
`node --test scripts/boundary-check.test.mjs`. It uses Node's existing built-in
test mechanism, mutates only disposable `/tmp` fixtures, and removes them after
each test. See [G1 enforcement runbook](../ops/book-core-g1-boundary.md).
