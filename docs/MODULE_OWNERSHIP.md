# Module Ownership and Change Responsibility

Status: Phase 1 baseline for Issues #15 and #20.

GitHub currently exposes one reliable repository owner account,
`@b827262-cell`. `.github/CODEOWNERS` uses only that verified account and this
document defines the role-based reviewers required in addition. Roles are not
invented GitHub handles.

## Responsibility matrix

| Module | Owner / required reviewer role | Public API | Allowed dependencies | Forbidden dependencies | Data ownership | Test responsibility | Security responsibility |
|---|---|---|---|---|---|---|---|
| `apps/AI-Stu-R1` | Student application owner; browser-boundary reviewer | Student routes, React entry, `studentClient.ts` | browser-safe contracts/schema/UI | Node APIs, DB client, server/provider entries, secrets | browser session/UI state only | component, client contract, build and browser smoke | no credentials in bundle; safe rendering and navigation |
| `apps/AI-adm-D1` client | Admin application owner; browser-boundary reviewer | React entry and `api.ts` | browser-safe contracts/schema/UI, `@ai-smartbook/ai/browser` | DB, Node APIs, AI `/server`, secret config | Admin UI/session presentation | component, API parser, client-boundary and build | no secret/provider/DB material in browser |
| `apps/AI-adm-D1/src/server` | Application server owner; platform security reviewer | HTTP routes and composition root | contracts, domain/orchestration public APIs, DB and server adapters | browser implementation details; raw exceptions as API | request lifecycle and API mapping, not domain/DB records | HTTP integration, auth boundary, error mapping | auth/origin enforcement, input limits, sanitized output |
| `apps/AI-Stu-R1/server` | Student API owner; platform security reviewer | Student HTTP routes | domain/schema/DB public APIs | Admin-only services, browser internals | request scope and student API mapping | HTTP integration and scope tests | authorization/scope mapping and sanitized output |
| `packages/contracts` | Contracts maintainer; affected consumer reviewers | package root, `/browser`, `/server` | Zod and pure JSON-compatible types | ORM/DB entities, provider SDKs, Node/browser implementation, secrets | wire format and compatibility fixtures | strict schema, fixture and boundary tests | classify exposure; exclude secret-bearing types |
| Domain packages (`quiz-core`, `book-core`, `student-runtime`) | Domain owner | declared package root exports | contracts, pure domain utilities and ports | apps, DB repositories, provider SDKs | domain rules and invariants | domain unit/property tests | authorization invariants expressed as domain policy where applicable |
| `packages/schema` | Schema maintainer; domain reviewer | package root Zod schemas | Zod, pure types | apps, DB repositories, provider SDKs | validation vocabulary; not persisted records | schema parse/reject tests | reject unsafe/unbounded inputs; no secret defaults |
| `packages/db` | Persistence owner; migration reviewer | package root repositories and DB factory | schema/domain public values, SQLite driver | apps/React, provider SDKs, public DTO ownership | schema, migrations, repositories, seed lifecycle | migration regression, repository integration, cleanup | parameterized access, sensitive-field storage and retention |
| `packages/ai` gateway/provider | AI platform owner; provider security reviewer | root, `/browser`, `/server` exports | contracts, declared ports, provider adapters | React/apps, DB implementation types in browser entry | provider-normalized request/result and usage policy | mock/provider compliance, redaction, retry/budget tests | credential isolation, egress, prompt/log redaction |
| `packages/ai/src/orchestration` | Orchestration owner; domain reviewer | `packages/ai` public orchestration exports | domain/contracts and declared ports | apps, DB rows, direct secret loading | workflow state and coordination decisions | workflow, concurrency, fallback and port contract tests | policy ordering, safe error propagation, least-privilege tool use |
| QM adapter / deployment boundary | Integration owner; platform security reviewer | No standalone adapter exists on `main`; future adapter must expose a declared port. `deploy/qm` is deployment-only | contracts and orchestration ports | browser imports, vendored QM internals, provider secrets in DTOs | integration state only; QM remains standalone | contract, adapter, smoke and browser-boundary tests | process/env boundary, secret redaction, no deployment mutation in tests |
| Release / ops (`scripts`, `deploy`, `.github`) | Release owner; operations reviewer | documented commands and CI workflows | public package commands, environment references | product deep imports without explicit reason; embedded credentials | release metadata and transient artifacts only | script typecheck/lint, dry-run/smoke, cleanup tests | no secret output, destructive-action gates, least privilege |

## Who may modify and who must review

- Any contributor may propose a change on a feature branch.
- The role named as owner is accountable for correctness; the named reviewer
  role must review boundary/security consequences.
- CODEOWNERS approval is necessary where configured but does not replace the
  role-based review above.
- A contributor acting in multiple roles must state this explicitly; high-risk
  changes should seek an independent reviewer when available.

## Cross-module minimum review

| Change | Required review | Minimum acceptance |
|---|---|---|
| Public contract/schema | Contracts maintainer + every affected producer/consumer owner | compatibility statement, strict fixture, schema test, typecheck |
| Browser/server export or import | Browser-boundary reviewer + package owner | boundary test and production browser build |
| Domain/DB mapping | Domain owner + persistence owner | migration/repository test and mapping test; no ORM type in public DTO |
| AI provider/orchestration | AI platform owner + provider security reviewer | mock-only deterministic test, budget/retry/redaction coverage |
| Auth/error/sensitive API shape | Application owner + platform security reviewer + contracts maintainer | HTTP status/envelope tests, no raw internal detail |
| Release/deployment script | Release owner + operations reviewer | dry-run or non-mutating verification, cleanup and secret scan |

All cross-module changes must pass relevant package tests plus root `typecheck`,
`lint`, `test` and `build`. A breaking contract additionally needs a new version,
migration plan and coexistence window. Product behavior and security controls are
outside this governance-only baseline unless separately authorized.

## Test placement

- Contract compatibility: `packages/contracts/test` and `fixtures/<version>`.
- Domain behavior: owning domain package tests.
- Adapter/persistence: adapter or DB integration tests, never browser tests.
- HTTP mapping/auth: owning app server integration tests.
- React rendering: owning app component tests.
- Boundary/release: closest package boundary test plus root/release scripts.

## Known baseline gaps (not fixed here)

- Most existing HTTP DTOs predate `packages/contracts`; migration remains
  endpoint-by-endpoint work.
- Some packages do not yet declare an `exports` map, so the no-deep-import rule
  is partly review-enforced until follow-up automation is approved.
- No standalone QM adapter exists in `main`; ownership and required boundary are
  defined before such code is introduced.
