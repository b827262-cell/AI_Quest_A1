# QM security boundary

This is a deployment-specific boundary document, not a claim that QM is a
hardened public multi-tenant service. QM remains experimental software and its
operator must review the upstream threat model before enabling real data.

## Request and data flow

```text
learner browser
    │ assignment submission / published feedback only
    ▼
AI_Quest_A1 server route
    │ auth + learner/teacher/TA authorization
    ▼
contracts → ai-orchestration port
    │ server-only adapter; opaque QM scope/run references
    ▼
standalone QM deployment (Phase 2)
    │ scoped workspace, sandbox, harness, audit
    ▼
existing AI Gateway / approved model provider
```

The browser imports only browser-safe contract/port entry points. It never
imports `@yc-software/qm`, the QM server adapter, Node built-ins, a DB client,
or credential code. `packages/ai-orchestration/src/server.ts` is the only
entry point that exposes the local adapter in this phase.

## Scope isolation

- `orgId` identifies the AI_Quest_A1 deployment; it is not a learner
  authorization grant.
- `scopeId`/`scopeKind` identify the class/course/learner collaboration scope.
  The future adapter must map them to QM scopes and verify the mapping on every
  request; it must never trust a client-provided QM scope reference.
- A learner is limited to their own submission and published learner-audience
  feedback. Learners cannot read teacher/TA drafts, another learner's scope,
  memory, keychain, files or run trace.
- Teacher/TA access is explicit and class/course-scoped. Approval and publish
  identity are recorded in `AgentRunTrace`; publication requires an approved
  draft.
- Org administrators are privileged operators. Their content-read and audit
  access must be separately authorized and logged in the future server route.

## Credential isolation

QM credentials, harness tokens, provider keys, OAuth secrets and signing keys
belong to the standalone server/deployment secret store. They are never DTO
fields, browser state, logs, trace bodies or DB seed data. The existing AI
Gateway remains responsible for provider credential selection and usage
normalization; the QM adapter must not bypass it for AI_Quest_A1 model calls.

The checked-in `.env.example` files contain names and safe comments only. Empty
placeholder names are not usable credentials. No `.env`, runtime DB, log dump,
Terraform state or production token belongs in this repository.

## Prompt injection and external content

Assignment text and referenced教材/knowledge sources are untrusted content.
The future QM adapter must preserve provenance labels, use the configured
screening policy for external data/tool results, and require human review before
learner delivery. The local baseline uses QM's conservative `auto` posture and
does not enable `dangerous`. Screening is defense in depth, not authorization;
teacher/TA publication policy remains an application responsibility.

The known limitations remain material: model output can be wrong, sandbox
processes are not trusted authorization decision-makers, credentials can be
readable while materialized in a sandbox, and content screening is heuristic.
Cloud deployment must add an operator-owned network/identity review rather
than treating QM's scope mechanism as a formal non-interference proof.

## Audit and trace

Every feedback run contract records:

- harness/agent and versions, including the fixed QM CLI version;
- prompt and rubric versions;
- provider/model, run id, timestamps, status and redacted error summary;
- source references and optional token/cost usage;
- human edit/review actor, role, time and note;
- publisher, role and publication time.

The application adapter persists workspace, submission, trace, draft and
publication documents in SQLite. Review and publication update the trace and
draft in one transaction; publication also inserts a unique publication event.
Authorization uses a server-authenticated actor plus workspace membership and
never treats request DTO role fields as authority.
