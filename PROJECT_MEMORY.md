# AI_Quest_A1 Project Memory

This file records durable operational facts that future maintainers and agents should check before proposing new runtime tooling.

## Canonical one-click runtime launcher

The repository already contains the canonical service control script at the repository root:

```bash
./reset-ai-smartbook.sh
```

Do **not** create a replacement systemd wrapper, alternate runtime CLI, or duplicate launcher before inspecting and reusing this script.

Supported actions:

```bash
./reset-ai-smartbook.sh start
./reset-ai-smartbook.sh stop
./reset-ai-smartbook.sh restart
./reset-ai-smartbook.sh status
./reset-ai-smartbook.sh logs
./reset-ai-smartbook.sh init-token
./reset-ai-smartbook.sh init-vault-key
```

The default action is `restart`:

```bash
./reset-ai-smartbook.sh
```

## Managed services and default ports

| Service | Default port |
|---|---:|
| Admin API | 4300 |
| Student API | 4310 |
| Student Web | 5173 |
| Admin Web | 5174 |

Default commands used by the launcher:

```bash
pnpm --filter AI-adm-D1 server:dev
pnpm --filter AI-Stu-R1 server:dev
STUDENT_API_TARGET=http://127.0.0.1:4310 pnpm --filter AI-Stu-R1 dev
pnpm --filter AI-adm-D1 dev
```

The script also manages PID/log directories, port cleanup, Admin token/vault-key prechecks, Admin readiness checks, Admin Vite proxy login checks, failed-start cleanup, status reporting, and log tailing.

## Operational rule

When AI_Quest_A1 services need to be restored on E500, the first-line command is:

```bash
cd <repo-checkout>
./reset-ai-smartbook.sh restart
```

`<repo-checkout>` is a placeholder for the local clone path of this repository on the E500 host. Replace it with the actual checkout location (for example, the output of `git rev-parse --show-toplevel` inside your clone), then run the launcher from there.

Use `status` before or after restart when diagnosing runtime state:

```bash
./reset-ai-smartbook.sh status
```

Do not manually kill unrelated Node processes or modify Cloudflare/DNS merely because ports 4300/4310 are down. Restore and verify the application runtime first.

## Expected Cloudflare mapping for the E500 runtime

The routing model below is the **expected configuration** for the E500 runtime; it is not a verified statement of the current live state.

- Verification status: not verified — no live DNS or Tunnel lookup was performed.
- Last reviewed: 2026-10-14.
- Source: repository documentation (this file) only.

```text
admin-api.b827262.org
  -> e500-ai-tutor Cloudflare Tunnel (expected)
  -> http://127.0.0.1:4300

student-api.b827262.org
  -> e500-ai-tutor Cloudflare Tunnel (expected)
  -> http://127.0.0.1:4310
```

The one-click launcher manages application processes only. It must not be treated as permission to modify Cloudflare DNS, Tunnel routes, credentials, authentication security, or unrelated host services.

## Source of truth

Before changing runtime behavior, inspect the actual repository files, especially:

- `reset-ai-smartbook.sh`
- `README.md`
- `scripts/ensure-admin-token.mjs`
- `scripts/ensure-vault-key.mjs`
- `apps/AI-adm-D1/package.json`
- `apps/AI-Stu-R1/package.json`

If this memory conflicts with executable code, the current repository code and verified runtime behavior are the source of truth; update this document in the same change.
