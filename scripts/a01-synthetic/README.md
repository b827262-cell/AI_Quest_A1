# A-01 synthetic traffic injector (draft)

Sends **signed** relay requests to a **staging** target to top up per-path
coverage for the A-01 72h observation window: every applicable path x verb gets
at least `--target` (default 30) successful `relay.verify` results, with the
server tagging each one `synthetic: true`.

This is a **draft** for review. It is not wired into CI and is not authorised to
run against any real environment until the Owner confirms the window, the
staging target and the test accounts (see `docs/ops/relay-rollout.md` §4.4).

## Safety model

- **Staging only.** The target comes from `A01_SYNTHETIC_BASE_URL`. An unset,
  non-`https`, credential-bearing, or production-looking host is rejected before
  anything is built or sent. The deny-list includes
  `*.b827262.chatgpt.site` (primary / student / admin) and can be extended with
  `A01_SYNTHETIC_DENY_HOSTS` / `A01_SYNTHETIC_DENY_SUFFIXES`.
- **Dry-run by default.** Nothing is sent unless `--confirm` **and**
  `A01_SYNTHETIC_CONFIRM=yes` are both present.
- **Secrets never leave the environment.** The signing key and edge secret are
  read from the process environment at run time. They are never logged, echoed,
  written to evidence, or included in error messages. The script never prints
  any environment variable value — only booleans describing whether a variable
  is set.
- **No production data.** Only synthetic payloads are sent; no real user data is
  read or written. No deploy, no migration, no force-push.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `A01_SYNTHETIC_BASE_URL` | yes | Staging origin (https). Refused if production. |
| `A01_SYNTHETIC_SITE` | yes (or `--site`) | `student` or `admin`. |
| `A01_SYNTHETIC_SIGNING_KEY` | live only | Relay signing key (>= 32 chars). Never printed. |
| `A01_SYNTHETIC_EDGE_SECRET` | no | Edge gate secret if the primary runs `require`. Never printed. |
| `A01_SYNTHETIC_USER_ID` / `A01_SYNTHETIC_USER_EMAIL` | live only | Test-account identity; must be listed in the primary's `A01_SYNTHETIC_ACCOUNTS` allowlist so the request is tagged `synthetic`. |
| `A01_SYNTHETIC_CONFIRM` | live | Must be `yes` to actually send. |
| `A01_SYNTHETIC_TARGET_PER_PATH` | no | Valid results per path x verb (default 30). |
| `A01_SYNTHETIC_RATE_LIMIT` | no | Max requests/sec (default 2). |
| `A01_SYNTHETIC_ERROR_RATE_STOP` | no | Stop when error rate exceeds this (default 0.2). |
| `A01_SYNTHETIC_MAX_5XX` | no | Stop when 5xx count exceeds this (default 5). |
| `A01_SYNTHETIC_STOP_FILE` | no | Path whose presence stops the run (default `tmp/a01-synthetic.stop`). |
| `A01_SYNTHETIC_EVIDENCE_DIR` | no | Evidence output dir (default `docs/evidence`). |
| `A01_SYNTHETIC_EXECUTOR` / `A01_SYNTHETIC_AUTHORIZATION_REF` | no | Recorded in the manifest for provenance. |
| `A01_SYNTHETIC_RUN_ID` | no | Run id (default timestamped). |

## Usage

```bash
# Plan only (default; no secrets needed, target still validated):
node scripts/a01-synthetic/inject.mjs --site student --dry-run

# Live run (staging only):
A01_SYNTHETIC_CONFIRM=yes \
A01_SYNTHETIC_BASE_URL=https://<staging-origin> \
A01_SYNTHETIC_SITE=student \
A01_SYNTHETIC_SIGNING_KEY=... \
A01_SYNTHETIC_USER_EMAIL=... \
node scripts/a01-synthetic/inject.mjs --site student --confirm --rate 2 --target 30
```

## Coverage plan

Derived from `docs/ops/relay-rollout.md` §4.4 (GET included per the Owner 18:00
decision):

- **student**: `GET /api/student/me`, `GET /api/student/progress`,
  `PUT /api/student/progress`.
- **admin**: `GET /api/admin/auth/me`, `GET /api/admin/overview`,
  `GET /api/admin/books`, `GET /api/admin/books/[id]`,
  `POST /api/admin/books`, `DELETE /api/admin/books`,
  `POST /api/admin/books/upload`, `DELETE /api/admin/books/[id]`.

`[id]` templates are resolved from `--id`. Synthetic samples are tagged
server-side and must be counted separately from natural traffic; they do **not**
count toward Student 300 / Admin 100.

## Stop conditions

The run stops (and reports a non-zero exit code) when any of these hold:

1. the stop file exists (`A01_SYNTHETIC_STOP_FILE`);
2. the error rate exceeds `A01_SYNTHETIC_ERROR_RATE_STOP` (after >= 10 attempts);
3. the 5xx count exceeds `A01_SYNTHETIC_MAX_5XX`.

## Cleanup

- Created resource ids returned by `POST /api/admin/books` are captured and
  stored **hashed** in the manifest (`created_ids_hashed`) for a later DELETE
  pass. The raw id is never stored.
- After the window, delete the synthetic rows, delete any synthetic R2 objects,
  and disable the test account / remove it from `A01_SYNTHETIC_ACCOUNTS`
  (Owner-directed).

## Evidence

Written to `A01_SYNTHETIC_EVIDENCE_DIR` (default `docs/evidence`) as
`<run_id>.manifest.json` and `<run_id>.summary.json`. Only aggregate counts,
route templates and a masked target host are stored — never request/response
bodies, query strings, headers, cookies or ids.

## Tests

```bash
node --test scripts/a01-synthetic/a01-synthetic.test.mjs
```

Covers signing canonicalisation, the staging guard, redaction, the plan, the
manifest and the runner (success, error, stop-file and 5xx paths).
