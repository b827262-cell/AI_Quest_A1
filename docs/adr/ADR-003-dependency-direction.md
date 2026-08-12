# ADR-003: Domain, Orchestration, Adapter and Provider Dependency Direction

Status: Accepted

## Context

Business workflow, persistence, provider calls and application wiring are all
present in the repository. Without an explicit direction, domain code can
become coupled to DB rows, HTTP clients or provider SDK types.

## Decision

Dependencies point inward:

```text
apps/composition -> orchestration/use cases -> domain + ports -> contracts
                         ^                         ^
                         |                         |
                 adapters/providers -------- implementations
```

Domain rules depend on domain values and ports only. Orchestration coordinates
ports. Adapters implement ports and map DB/provider representations. Providers
never define public application contracts. Apps own composition and HTTP/UI
edges, not reusable domain policy.

## Alternatives

- Active-record domain tied to ORM: rejected due to persistence coupling.
- Provider SDK types as ports: rejected due to vendor lock-in and secret risk.
- Apps calling providers directly: rejected because policy and observability
  become inconsistent.

## Consequences

Adapters perform explicit mapping. Mock providers remain replaceable. Cycles and
cross-layer convenience imports are treated as design defects.

## Migration / Enforcement

Existing code is migrated incrementally. New changes must use public package
entries and state allowed dependencies in review. Boundary and package tests
enforce import direction where automated checks exist; ownership review covers
the remaining graph.
