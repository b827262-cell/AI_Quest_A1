# ADR-005: Public Module Entries and No Deep Imports

Status: Accepted

## Context

Deep imports bypass package ownership, allow internal file moves to break
consumers and can cross browser/server or domain/adapter boundaries unnoticed.

## Decision

Consumers import only paths declared in a package's `exports`. The root entry is
the general public surface; `/browser` and `/server` express runtime boundaries.
Paths under `src/internal`, repository implementations, provider implementations
and DB schema internals are not public. Relative imports remain allowed within
the owning package.

## Alternatives

- Document internals but permit imports: rejected because documentation does
  not prevent accidental dependencies.
- Export every source path: rejected because it eliminates ownership control.
- Ban all subpaths: rejected because explicit runtime boundaries are useful.

## Consequences

Public API changes are intentional and reviewable. Internal refactors remain
possible. Some existing deep imports require staged migration.

## Migration / Enforcement

Package `exports`, boundary tests and lint/review checks enforce the rule. A new
subpath requires an ADR-compatible purpose, owner and consumer list. Existing
violations are recorded and migrated separately; Phase 1 does not alter product
behavior to remove them.
