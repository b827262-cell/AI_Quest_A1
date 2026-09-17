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
    "deployed_git_sha": "f0085202150c67760040644f1db3d6c479dc2074",
    "health_endpoint": "https://ai-quest-a1-backend.b827262.chatgpt.site/api/health",
    "health_status": 200,
    "bindings": {
      "DB": {
        "type": "d1",
        "resource_id": "opaque-id",
        "identity_source": "unavailable",
        "readable": true
      },
      "BOOKS_BUCKET": {
        "type": "r2",
        "resource_id": "opaque-id",
        "identity_source": "unavailable",
        "list_readable": true,
        "get_readable": true
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

Key contract and validation requirements:
- **Freshness (FPT-1 / F5)**: `captured_at` must be within `--max-age-hours` (default 24h) and not in the future.
- **Pairwise Distinct Project IDs (FPT-2)**: The 3 site project IDs (`shared_backend`, `student`, `admin`) must all be non-empty and distinct.
- **Health Endpoint Anchoring (FPT-4)**: `worker.health_endpoint` origin must match `SHARED_BACKEND_ORIGIN` (`https://ai-quest-a1-backend.b827262.chatgpt.site`).
- **Resource ID Echo Guard (F1)**: If `resource_id` echoes the binding name (`"DB"` or `"BOOKS_BUCKET"`), `identity_source: "unavailable"` is strictly required.
- **Distinct Binding Resource IDs (FPT-5)**: D1 and R2 bindings must not have identical resource IDs.
- **Deployed Git SHA (F2)**: `worker.deployed_git_sha` records live commit; any lag against repo branch base is explicitly flagged.
- **Repo Root Hygiene (F3)**: The legacy `.openai/hosting.json` at repo root is removed; if present, its `project_id` must match `shared_backend`.

## Run

```bash
node site/scripts/verify-environment-alignment.mjs --json
```

For a fixture or an evidence candidate outside the default location:

```bash
node site/scripts/verify-environment-alignment.mjs \
  --manifest /path/to/manifest.json \
  --hosting site/.openai/hosting.json \
  --max-age-hours 24 \
  --json
```

### Exit Codes (F7)
- `0`: PASS (`status="PASS"`, `config_drift="NO"`)
- `1`: FAIL / Config drift (`status="FAIL"`, `config_drift="YES"`)
- `2`: CLI usage / argument error

## Tests

```bash
node --test site/tests/environment-alignment.test.mjs
```

The test suite covers:
- Passing alignment and drift detection
- Project mismatches and missing/unreadable bindings
- Freshness threshold violations (FPT-1)
- Duplicate project IDs across sites (FPT-2)
- Untrusted health endpoint origin (FPT-4)
- Binding-name echoing without `identity_source: "unavailable"` (F1)
- Identical D1/R2 resource IDs (FPT-5)
- Unconditional real-file verification (F6)
- CLI subprocess exit codes: 0 (PASS), 1 (FAIL), 2 (Usage error) (F7)

