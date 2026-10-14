# PR #33 SSRF hardening port to main — 2026-10-14

Base: `ef1c14ec78a0c1d3aa7f3db683ceb677f1db685d` (remote main at clone time).
Source: `ae5b351baf04af281c206005fed73c543e4e488b`.
Destination branch: `fix/rag-ssrf-dns-pinning`.
Work performed in a fresh `/tmp` clone. No production calls, credentials, merge,
deployment, or PR creation. Adversarial tests use injected DNS/HTTP/TLS mocks.

## Port decisions

- Port `pinned-fetch.ts`: resolve/validate all DNS answers once; dial the validated
  IP with the original hostname for TLS verification and HTTP Host. Keep manual
  redirect handling in the adapter and reject cross-origin redirects before
  sending another credential-bearing request.
- Port the adapter and its existing tests from fetch injection to pinned transport
  injection. Keep current main exports, dependencies, and package metadata.
- Port runtime DNS validation in `safe-url.ts`, correcting source's TEST-NET-1
  typo (`192.0.173` -> `192.0.2`). Canonicalize IPv6 so expanded loopback and
  hex-encoded IPv4-mapped private addresses cannot bypass classification. Reject
  invalid DNS answers and non-global/special IPv6 ranges conservatively.
- Harden the source transport's cancellation and stream-error handling: include
  DNS in the timeout, reject pre-aborted requests without dialing, reject stream
  errors through the promise, and handle null-body response statuses.
- Port the 35 adversarial cases and add 19 regressions, including a test through
  the actual Node HTTPS request client backed by a mock TLS Duplex socket. This
  verifies the real client invokes the pinned connection hook, resolves once,
  and keeps original-hostname TLS verification enabled.
- Port G1 hard failures and machine-readable `GATE_STATUS`. Discard the source's
  ineffective deferral branch (it reset its own environment flag and never cleared
  FAIL). No deferral or architectural refactor is introduced.
- Add the SSRF release-gate step. Add only the `ai:test:ssrf` root script, using
  an explicit Vitest file selector. Preserve main's `type: module`, pnpm overrides,
  all dependencies, and every lockfile byte.
- Replace the historical source review report with this port report. Do not copy
  its earlier model identity, execution claims, test counts, or PR-ready claims.

## Validation

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Installed without lockfile changes |
| `pnpm --filter @ai-smartbook/ai typecheck` | 0 | Pass |
| `pnpm --filter @ai-smartbook/ai test` | 0 | 799/799, 53 files |
| `pnpm run ai:test:ssrf` | 0 | 54/54 |
| `pnpm --filter AI-Stu-R1 typecheck` | 0 | Pass |
| `pnpm --filter AI-Stu-R1 test` | 0 | 66/66, 12 files |
| `pnpm --filter AI-adm-D1 typecheck` | 0 | Pass |
| `pnpm --filter AI-adm-D1 build` | 0 | Pass |
| `pnpm --filter AI-adm-D1 test` after build | 0 | 296/296, 30 files |
| `pnpm audit --json` (before and after port) | 1 | critical 0, high 0, moderate 4, low 1, unchanged |
| `bash scripts/boundary-check.sh` | 1 | G1 remains a blocker: book-core depends on/imports ai/db; `GATE_STATUS: FAIL` |
| `pnpm run typecheck:release-scripts` | 1 | Four pre-existing errors; identical output using main's unmodified release script |
| `git diff --check` | 0 | Pass |
| `git diff --quiet origin/main -- pnpm-lock.yaml` | 0 | Lockfile unchanged |

The initial admin test run was 295/296 because its security-bundle test requires
`dist/index.html`. Running the required build then rerunning tests produced
296/296. The test was not weakened or skipped.

Negative regression check: temporarily disable the resolved-IP guard and run
`pnpm run ai:test:ssrf`: exit 1, 22 failed / 32 passed. Restore the original file
in `finally`, then rerun: 54/54, exit 0. No mutation is committed.

The additional release-script typecheck reports unresolved contracts and
better-sqlite3 declarations, plus a pre-existing harness callback type mismatch.
A baseline run with main's release-gate script produces byte-identical output.
These unrelated script errors are not repaired in this SSRF port.

The full operational release gate was not run: it includes credential/provider
smokes outside this local-only verification. This branch is not a release-ready
claim: G1 remains FAIL and production TLS/provider behavior was not exercised.
