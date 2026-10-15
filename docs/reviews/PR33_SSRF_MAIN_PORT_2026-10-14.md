# PR #33 SSRF hardening port to main — 2026-10-14

> Current policy: issue #49 stages 1/2 removed book-core ai/db dependencies.
> Stage 3 makes their reintroduction a hard G1 failure; see
> [ADR-002](../adr/ADR-002-browser-server-boundary.md). WARN results below are
> historical evidence from the earlier SSRF port, not the current policy.

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
- Keep main's boundary policy: book-core -> ai/db dependencies remain WARN and
  there is no additional book-core source hard check. Preserve machine-readable
  `GATE_STATUS: PASS | FAIL` without changing the underlying main exit behavior.
  Hard G1 enforcement belongs in a separate PR.
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
| `pnpm --filter @ai-smartbook/ai test` | 0 | 810/810, 53 files |
| `pnpm run ai:test:ssrf` | 0 | 65/65 |
| `pnpm --filter AI-Stu-R1 typecheck` | 0 | Pass |
| `pnpm --filter AI-Stu-R1 test` | 0 | 66/66, 12 files |
| `pnpm --filter AI-adm-D1 typecheck` | 0 | Pass |
| `pnpm --filter AI-adm-D1 build` | 0 | Pass |
| `pnpm --filter AI-adm-D1 test` after build | 0 | 296/296, 30 files |
| `pnpm audit --json` | 1 | critical 0, high 0, moderate 4, low 1, unchanged |
| `bash scripts/boundary-check.sh` | 0 | WARN only for book-core -> ai/db; `GATE_STATUS: PASS` |
| main `ef1c14e` boundary script via `git show origin/main:scripts/boundary-check.sh` piped to `bash` | 0 | Same WARN behavior; main has no GATE_STATUS line |
| `pnpm run typecheck:release-scripts` (prior port baseline; not rerun in this follow-up) | 1 | Four pre-existing errors; identical output using main's unmodified release script |
| `git diff --check` | 0 | Pass |
| `git diff --quiet origin/main -- pnpm-lock.yaml` | 0 | Lockfile unchanged |

The initial admin test run was 295/296 because its security-bundle test requires
`dist/index.html`. Running the required build then rerunning tests produced
296/296. The test was not weakened or skipped.

Negative regression checks (this follow-up):

- Temporarily disable the resolved-IP guard, then `pnpm run ai:test:ssrf`: exit 1,
  **25 failed / 40 passed**. Restore the exact original bytes in `finally`.
- Temporarily set `agent: false` in the pinned transport, then run
  `pnpm --filter @ai-smartbook/ai exec vitest run test/rag/ssrf-adversarial.test.ts -t "uses the pinned createConnection hook"`:
  exit 1, **1 failed / 64 skipped**. The mock Agent guard fails before any network
  connection. Restore the exact original bytes in `finally`.
- After restoring both mutations, `pnpm run ai:test:ssrf`: **65/65, exit 0**.
  No mutation is committed.

The additional release-script typecheck reports unresolved contracts and
better-sqlite3 declarations, plus a pre-existing harness callback type mismatch.
A baseline run with main's release-gate script produces byte-identical output.
These unrelated script errors are not repaired in this SSRF port.

The full operational release gate was not run: it includes credential/provider
smokes outside this local-only verification. Production TLS/provider behavior was not exercised; no release-readiness claim
is made. The local boundary step is PASS and does not block the SSRF gate step.


## PR #48 A/B follow-up

Eleven new cases bring the adversarial suite to 65 tests and the AI suite to
810 tests; the existing native-client test also gains explicit Agent guards.

The earlier report incorrectly described the hard G1 failure as existing main
behavior. Main `ef1c14e` reports only WARN and exits 0. Commit `caeb354` introduced
the hard failure during the port. This follow-up restores main's policy, removes
the added book-core source hard check, and corrects that attribution. No G1
architecture refactor or hard enforcement is included.

- **B1:** IPv6 canonicalization is wrapped in try/catch, returning false for zone
  IDs or other uncanonicalizable DNS answers. Three scoped-IPv6 cases assert the
  stable `unsafe_dns:resolved_ip_blocked` result rather than a parser exception.
- **B2:** Strengthen the real Node HTTPS client / mock TLS socket regression:
  Agent.addRequest is guarded against use, request options must omit agent and
  include createConnection, and TLS must dial the validated IP with the original
  hostname and certificate verification enabled. No live sockets are opened.
- **B3:** Count followed redirects explicitly, independently of loop detection.
  Maximum **five followed redirects = six total requests including the initial
  request**. Test zero redirects, success after five, and rejection of a sixth
  redirect without issuing a seventh request. The old set-size expression was
  ambiguous to review; six requests by itself is consistent with five redirects.
- **B4:** `MAX_LLM_RESPONSE_BYTES = 4 * 1024 * 1024` limits one non-streaming LLM
  JSON response to **4 MiB**. This leaves generous room for text/usage metadata
  while bounding accumulated response buffers. Reject an oversized Content-Length
  immediately; count actual bytes independently so absent/understated lengths
  cannot bypass the cap. Destroy the response/request on overflow. Tests accept
  below/exactly the cap and reject a single oversized chunk, accumulated overflow,
  and an oversized declared length before body consumption.

All follow-up work uses a new `/tmp` clone at `caeb354`; only an appended commit
is pushed to the existing branch. No force push, new PR, merge, deployment,
credentials, lockfile changes, or type:module changes.
