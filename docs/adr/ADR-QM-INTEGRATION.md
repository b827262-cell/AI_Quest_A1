# ADR: QM integration as an independent deployment plus adapter

- Status: Accepted for Phase 1 baseline
- Date: 2026-08-04
- Issue: #5
- Fixed QM CLI: `@yc-software/qm@0.1.4`

## Context

AI_Quest_A1 already separates Browser and Server code, domain rules, the DB,
AI Gateway and orchestration. QM is a standalone multiplayer agent harness
with its own scope, sandbox, credentials, scheduler and persistence model. Its
published deployment CLI requires Node 24+ and is intended to materialize an
organization deployment directory rather than require a source checkout.

The teaching use case needs a smaller, stable contract: a learner submits an
assignment; an agent produces a feedback draft; a teacher or TA reviews it; and
an authorized teacher/TA publishes it to the learner. The application must
retain enough run evidence to explain which agent, prompt, rubric, provider,
model and human decisions produced the published result.

## Decision

1. Keep QM in `deploy/qm/` as a standalone deployment directory outside the
   pnpm workspace. Its `package.json` pins `@yc-software/qm` to exact version
   `0.1.4`; the directory does not contain QM core source.
2. Put the cross-boundary DTOs and Zod schemas in
   `@ai-smartbook/contracts` (`packages/contracts`). The contracts contain no
   database rows, React props, provider SDK responses or secrets.
3. Put the QM-compatible application port and workflow in
   `@ai-smartbook/ai-orchestration`. The server entry contains the local
   in-memory adapter used by this phase. A future adapter may call the
   standalone deployment API, but QM internal types must remain private to
   that adapter.
4. Keep actual model/provider calls behind the existing AI Gateway boundary.
   This phase uses a deterministic local adapter for smoke tests and does not
   route production learner data to QM or a model provider.
5. Use QM's conservative `auto` security posture in the local config. No
   `dangerous` setting, production cloud command, Slack production token or
   automatic deployment workflow is introduced.

## Scope and identity mapping

The application owns `orgId`, class/course/learner identifiers and the
published-feedback authorization decision. A QM deployment adapter will map
those values to QM scope references without returning QM's internal principal,
memory or keychain types to the domain. A learner can see only feedback whose
`audience` is `learner` and whose submission belongs to that learner. Teacher
and TA review/publish identities are recorded in the run trace.

## Alternatives considered

### Vendor the QM repository

Rejected. It would duplicate the core, create an upgrade and license surface,
and violate the upstream deployment-directory guidance.

### Import QM server internals into `quest-core` or the existing AI package

Rejected. It would cross the domain, DB, Browser/Server and provider boundaries
and make QM's runtime choices part of the teaching domain.

### Call QM directly from the browser

Rejected. It would expose deployment identity/scope data and potentially
credentials. Only a server-side adapter may cross the QM boundary.

### Deploy Fly.io/AWS or enable Slack now

Rejected for Phase 1. The acceptance criteria require a local, reproducible
baseline; cloud accounts and production credentials are explicitly out of
scope.

## Consequences

Positive:

- QM can be upgraded by changing one deliberate exact dependency pin and
  rerunning deployment validation.
- The learner feedback contract can be tested without Node, QM, Postgres,
  Docker or provider credentials.
- Browser bundles cannot import the server adapter through the explicit
  `./browser` entry.

Trade-offs:

- The local adapter is not durable and is not a production implementation.
- Phase 2 must implement a server-only QM HTTP/deployment client and a DB
  repository for trace/draft persistence, plus an authorization review.
- The standalone deployment has an independent Node/npm lifecycle from the
  pnpm monorepo.

## Exit criteria for Phase 2

- Pin is upgraded deliberately only after `qm check` and contract tests pass.
- A server-only deployment adapter maps scope, run, review and publish events
  with authenticated service credentials.
- DB persistence and audit events are transactionally linked to publication.
- Browser bundle inspection proves no Node/QM SDK/DB client reaches a SPA.
- A staging-only deployment passes `qm check`, `qm doctor`, and the feedback
  workflow smoke test without real learner data.
