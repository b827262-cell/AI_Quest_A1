# AI_Quest_A1 Isolated Security Test Environment Guide (Phase 1 / Issue #17)

- **Owner**: Codex
- **Task**: Issue #17-3 (Prep 17-3)
- **Status**: Completed
- **Date**: 2026-08-05

---

## 1. Overview & Isolation Boundaries

This document defines the architecture, configuration, and execution procedures for the **Isolated Security Test Environment** in `AI_Quest_A1`.

The test environment is designed to execute security audit cases (Claude AC-1 ~ AC-10) in complete isolation from production and external services.

### Key Isolation Constraints:
1. **Isolated Ports**: Dedicated test ports `3102` (Admin API) and `3103` (Student Web) to prevent port collisions with development services.
2. **Ephemeral Database**: Uses a dedicated SQLite database at `data/test-isolated-security.db`, completely isolated from `ai-smartbook-r1.db`.
3. **No External Network Calls**: Strictly uses synthetic stubs/fakes; zero calls to live AI providers, QM production servers, or external URLs.
4. **Zero Production Secrets**: Uses synthetic token/key replacements specified in `.env.test.example`. Real production secrets or API keys are strictly forbidden.

---

## 2. Environment Variables & `.env.test.example`

Configuration is managed via `.env.test.example`:

| Environment Variable | Recommended Value | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `test` | Sets node environment mode |
| `PORT` | `3102` | Admin API isolated test port |
| `STUDENT_PORT` | `3103` | Student Web isolated test port |
| `DATABASE_URL` | `file:./data/test-isolated-security.db` | Ephemeral test database path |
| `ADMIN_API_TOKEN` | `synthetic_test_admin_token_valid_9999` | Synthetic admin token for test auth |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | `00112233445566778899aabbccddeeff...` | 256-bit test AES key for crypto unit tests |
| `MOCK_AI_PROVIDER_ENABLED` | `true` | Enables local mock provider stub |

---

## 3. Synthetic Security Fixtures (`tests/fixtures/security/`)

The isolated test harness relies on 7 standardized JSON fixture datasets located in `tests/fixtures/security/`:

1. `roles.json`: Synthetic teacher, TA, student, guest, and unauthorized role specifications with scope boundaries.
2. `tokens.json`: Synthetic valid, expired, revoked, stale replay, and malformed admin tokens.
3. `responses.json`: Standard HTTP response templates for 401 (auth), 403 (authorization), 404 (business not found), 422 (validation error), and 503 (provider unavailable).
4. `prompt-injections.json`: Synthetic direct & indirect prompt injection samples for AC-7 guardrail testing.
5. `upload-samples.json`: Safe synthetic boundary test samples (invalid MIME, oversized metadata, path traversal filenames).
6. `ssrf-targets.json`: Test URL targets (loopback, IPv6, cloud metadata, RFC1918 private ranges) for AC-8/SSRF testing.
7. `scope-data.json`: Synthetic multi-course, multi-class, multi-learner dataset for AC-4/AC-5 IDOR and scope escalation testing.

---

## 4. Lifecycle & Command Reference

### 4.1 Health Check (Doctor)
Run the environment doctor script to verify Node version, template presence, fixture integrity, and port availability:
```bash
node scripts/security-test-env-doctor.mjs
```

### 4.2 Setup Environment
Initialize `.env.test`, touch `data/test-isolated-security.db`, and validate synthetic fixtures:
```bash
node scripts/security-test-env-setup.mjs
```

### 4.3 Validate Synthetic Fixtures
Validate all synthetic JSON fixtures for syntax and secret leakage:
```bash
node scripts/validate-security-fixtures.mjs
```

### 4.4 Launch Server in Isolated Test Mode
To start the Admin API server attached to the isolated test database:
```bash
PORT=3102 DATABASE_URL=file:./data/test-isolated-security.db pnpm --filter AI-adm-D1 dev
```

### 4.5 Teardown & Cleanup
Clean up ephemeral database files and temporary artifacts:
```bash
node scripts/security-test-env-cleanup.mjs
```

---

## 5. Verification Invariants

- **Fail-Closed Guarantee**: Any missing credential or unauthorized access attempt must fail closed with an explicit error code.
- **Deterministic Teardown**: Running `security-test-env-cleanup.mjs` guarantees zero leftover background processes, logs, or SQLite WAL/SHM files.
