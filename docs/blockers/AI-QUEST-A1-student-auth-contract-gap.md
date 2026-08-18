# Blocker: Student Auth frozen-contract gap

## Status

Open. Discovered during the Student Auth Foundation preflight on branch
`agent/student-auth-foundation`.

## Evidence

- The requested `@ai-smartbook/contracts` package is not present in this
  worktree or in the current pnpm workspace.
- The only contract-like package is the legacy `@ai-smartbook/schema`; its
  public entry exports book, chat, appearance, AI, sync and token-pool
  schemas, but no Student Auth, Google identity, session or profile DTOs.
- `packages/auth/src/index.ts` is an empty placeholder and no Student user,
  OAuth-state, or revocable-session tables exist in the current DB schema.
- Student `/login` is currently a localStorage mock flow and the Student API
  has only an in-memory PDF reader session.

## Impact

The frozen request/response and error-code contract needed to expose Google
login, session restoration/refresh/revocation, and profile completion cannot be
validated from this worktree. Creating `@ai-smartbook/contracts` or adding
Student Auth exports to `@ai-smartbook/schema` would expand the frozen public
contract, which is explicitly outside this work line's authority.

## Required owner decision

Provide or merge the frozen `@ai-smartbook/contracts` public exports for:

- Google login start/callback and OAuth error responses;
- authenticated session/me response and stable unauthenticated/expired errors;
- profile completion read/update request and response;
- redirect/gate reason values.

Once supplied, this blocker can be closed and the Student API/Web adapters can
bind to those exports without inventing a parallel contract.
