# Phase 4A environment-alignment gate

`site/scripts/verify-environment-alignment.mjs` is the fail-closed release gate
for the Shared Backend Sites deployment. It compares the committed target
declaration at `site/.openai/hosting.json` with a fresh read-only control-plane
manifest. It does not call a provider API and is safe to run offline.

## Source-of-truth manifest contract

The evidence collector writes
`docs/phase4a/environment-source-of-truth.json` alongside the human-readable
`ENVIRONMENT_SOURCE_OF_TRUTH.md`. The JSON document is deliberately identity-
and status-only; it must not contain credentials, D1 rows, R2 object data, or
signed URLs.

```json
{
  "manifest_version": "phase4a.environment-source-of-truth/v1",
  "environment": "staging",
  "captured_at": "2026-09-17T00:00:00.000Z",
  "sites": {
    "shared_backend": { "project_id": "appgprj_..." },
    "student": { "project_id": "appgprj_..." },
    "admin": { "project_id": "appgprj_..." }
  },
  "worker": {
    "project_id": "appgprj_...",
    "version": "appgver_...",
    "health_endpoint": "https://.../api/health",
    "health_status": 200,
    "bindings": {
      "DB": { "type": "d1", "resource_id": "opaque-id", "readable": true },
      "BOOKS_BUCKET": {
        "type": "r2", "resource_id": "opaque-id",
        "list_readable": true, "get_readable": true
      }
    }
  }
}
```

The collector must obtain every value in this manifest in its current
read-only run. Historical reports are not valid substitutes for a required
field. The `environment` is intentionally restricted to `staging` or
`production`; this prevents an arbitrary label from being mistaken for a
deployment target.

## Run

```bash
node site/scripts/verify-environment-alignment.mjs --json
```

For a fixture or an evidence candidate outside the default location:

```bash
node site/scripts/verify-environment-alignment.mjs \
  --manifest /path/to/manifest.json \
  --hosting site/.openai/hosting.json \
  --json
```

The result is machine-readable JSON with `status`, `config_drift`, all checks,
and errors. `status=FAIL` and `config_drift=YES` always return non-zero. The
validator requires the shared-backend project ID to match both repo hosting
and Worker identity, exact `DB`/`BOOKS_BUCKET` names, expected D1/R2 types,
non-empty resource IDs, a successful HTTPS health result, and evidence that
D1/R2 reads succeeded. Student and Admin project IDs are mandatory evidence
but are not deployment targets in this repository; they delegate to the shared
backend under the Phase 3E sync contract.

## Tests

```bash
node --test site/tests/environment-alignment.test.mjs
```

The fixtures cover a passing alignment, an incorrect Sites project, and
missing/unreadable D1/R2 bindings. No live credentials or control-plane access
is required.
