# Contract Boundaries and Versioning Baseline

Status: Phase 1 baseline for Issues #15 and #18.

## Inventory and source of truth

| Contract | Version | Boundary | Owner | Purpose | Consumers | Runtime schema |
|---|---:|---|---|---|---|---|
| Public API error | 1 | browser-safe | Contracts maintainer | Sanitized, stable API failure envelope | Admin/Student browsers and API servers | `publicApiErrorV1Schema` |
| Public actor | 1 | browser-safe | Contracts maintainer + domain reviewer | Minimal actor identity crossing an API boundary | Browser applications and API servers | `publicActorV1Schema` |
| Audit event | 1 | server-only | Platform security reviewer | Sanitized server event handed to audit persistence | Application server and persistence adapter | `auditEventV1Schema` |

The machine-readable form is `packages/contracts/src/catalog.ts`. New public
contracts must be added to both locations in the same change.

Existing DTOs in `apps/AI-adm-D1/src/api.ts`, `apps/AI-Stu-R1/src/studentClient.ts`
and `packages/schema` predate this package. They are migration candidates, not
silently declared compliant. Moving them is a later, behavior-changing task and
must preserve their HTTP compatibility.

## Boundary rules

- `@ai-smartbook/contracts` and `/browser` are browser-safe. They may contain
  JSON-compatible DTOs, pure Zod schemas and public enums only.
- `/server` is explicit server-only contract surface. It may describe sanitized
  server-to-adapter values, but not credentials, provider SDK objects or ORM rows.
- `src/internal/` contains implementation types and is absent from package
  `exports`; consumers may not deep import it.
- ORM models, DB entities, provider SDK types, request objects, filesystem
  handles, environment objects and secret-bearing configuration are never public
  contracts.

## Version evolution

1. Each wire contract carries a numeric `contractVersion` literal.
2. Backward-compatible additions are optional fields or new enum values only
   when all consumers already handle unknown values safely.
3. Removing or renaming a field, making an optional field required, narrowing a
   value, or changing semantics is breaking and requires a new versioned schema.
4. Deprecation requires owner, replacement, consumer inventory and removal date.
5. Old and new versions coexist until every named consumer migrates and the
   compatibility fixture for the old version can be intentionally retired.
6. Adapters migrate at the edge. Domain and DB models do not leak into the wire
   format merely to avoid mapping code.

## Enforcement

- `fixtures/v1/*.json` are immutable compatibility examples.
- `contracts.test.ts` parses each fixture with strict schemas and rejects version
  drift or required-field removal.
- `boundary.test.ts` checks package exports and browser source for forbidden
  server/internal material.
- Typecheck is necessary but insufficient; fixture and boundary tests are
  mandatory for contract changes.

## Change checklist

- Identify owner, purpose and every producer/consumer.
- Classify browser-safe, server-only or internal before authoring.
- Add/update strict runtime schema, DTO type, fixture and catalog entry.
- State compatibility impact and migration path in the PR.
- Obtain reviews required by `docs/MODULE_OWNERSHIP.md`.
