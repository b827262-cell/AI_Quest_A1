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
