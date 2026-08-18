# ADR-004: Error Model and API Response Contract

Status: Accepted

## Context

Applications currently return several endpoint-specific error shapes. Raw
exceptions, provider messages or DB failures are unsafe and unstable public API.

## Decision

New or migrated APIs use the versioned `PublicApiErrorV1` envelope with stable
code, category, safe message, retryability and optional request ID. Categories
separate authentication, authorization, validation, business, conflict,
rate-limit, infrastructure and internal failures. Internal cause, stack, SQL,
provider payload, credential and environment data never enter the response.

HTTP status and error category must agree. Domain/adapters throw internal typed
errors; the HTTP edge maps them once into the public envelope.

## Alternatives

- Return exception messages: rejected as unsafe and unstable.
- Use HTTP status alone: rejected because clients need stable behavior codes.
- Return provider errors verbatim: rejected because vendors and sensitive data
  would become public contract.

## Consequences

Clients can handle errors consistently. Servers maintain a mapping layer and
safe observability correlation. Existing endpoints migrate without silently
changing their response shape.

## Migration / Enforcement

Add contract fixtures and endpoint tests before migration. Any change to a
public code/category is a compatibility review. Logs may retain approved
sanitized diagnostics keyed by request ID, never by exposing them to clients.
