# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Controlled E500 import

The E500 importer is one-way: local E500 APIs/filesystem -> this site's
internal sync API -> D1/R2. E500 never receives D1/R2 credentials, and Sites
changes are not exported back. Public student/admin requests cannot call the
internal routes: without a valid HMAC they answer 401 (guest) or 403
(signed-in visitor). Configure `SYNC_IMPORT_SECRET` only as a runtime secret on
the shared backend and provide it to the CLI through the process environment;
it is never stored in the repository or printed.

```bash
E500_STUDENT_URL=http://127.0.0.1:4310 \
E500_ADMIN_URL=http://127.0.0.1:4300 \
E500_ADMIN_AUTHORIZATION="Bearer <local-admin-token>" \
E500_BOOKS_DIR=/path/to/e500/uploads/books \
npm run sync:e500:dry-run
```

For an actual import, additionally set `SYNC_BACKEND_URL` and
`SYNC_IMPORT_SECRET`, then run the narrowest command needed, or
`npm run sync:e500:all`. Batches are bounded and retried; every transport
retry is re-signed with a fresh timestamp+nonce (server replay protection
never blocks a safe retry), while duplicate business writes are prevented by
per-item version/checksum idempotency. PDF object keys are server-generated as
`books/{book_id}/{sha256}.pdf`. Set `SYNC_RUN_ID` to resume an interrupted run
without creating a second run.

Known limit: the JSON `contentBase64` transport is capped by the 8,000,000
character body limit, so its effective payload is about 6 MiB. PDFs above that
must use the raw `application/pdf` request path (limit `SYNC_MAX_PDF_BYTES`,
default 50 MiB).

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
