# PR #32 — Hermes (poolside/laguna-s-2.1) Remediation Evidence

**Date:** 2026-08-12
**Rejected base SHA:** `0cd41b272efb2b7ad06f20784d66700659018167`
**Remediation branch:** `fix/pr32-r4-ssrf-gate-hardening`
**Base for merge:** `agent/student-rag-release-gate`
**Canonical toolchain:** pnpm `9.15.0`, Node `v24.18.1`

> NOTE ON EXECUTING MODEL: The remediation was authored and verified under the
> `poolside/laguna-s-2.1` agent assignment. This report is produced by that
> agent; the executing model identity is recorded honestly as required by the
> task instructions.

---

## 1. R-4 — Runtime SSRF transport hardening

The rejected HEAD only validated the LLM `baseUrl` **textually at construction
time**. The actual HTTP request used the runtime `fetch` implementation, which:

- performed its **own independent DNS lookup** at connect time (DNS-rebinding /
  TOCTOU gap), and
- followed `3xx` redirects **automatically**, which could forward the API key
  to a private/loopback/metadata endpoint.

### Fix design (validated-address → connected-address binding)

The single chokepoint for all outbound provider traffic is now
`CerebrasLlmProvider.executeWithRedirectControl(...)`, which delegates the
connection to a **pinned transport** (`packages/ai/src/rag/pinned-fetch.ts`):

1. **`resolveSafeAddress(url, { resolver })`** (`safe-url.ts`) resolves the
   hostname to concrete IPs and validates every resolved address against the
   private/loopback/link-local/metadata/multicast/reserved ranges. It is the
   **only** source of the destination address.
2. **`pinnedFetch`** dials the socket **directly to the validated IP** via
   `tls.connect({ host: <validated-ip>, servername: <original-hostname>,
   rejectUnauthorized: true })` (or `net.connect` for plain http). There is
   **no second DNS lookup** — the validation lookup and the connect lookup are
   the same call. TLS certificate verification stays ON; SNI/cert match the
   **original hostname** (not the IP), so MitM on the pinned IP is rejected.
3. **Redirect control:** the request uses no automatic redirect following; each
   `3xx` is re-validated through the full SSRF chain (static URL + DNS pin) and
   the credential is only attached to a re-validated, same-origin hop.
4. **Cross-origin redirect policy (P3):** a `3xx` pointing to a **different
   origin** is rejected fail-closed (`unsafe_redirect:cross_origin`). The
   Cerebras `Authorization` credential is never forwarded to an arbitrary
   redirected host.

### Security properties proven by the adversarial suite

| Property | Result |
|---|---|
| Static URL rejects private/loopback/metadata/non-HTTPS/odd-port/userinfo | PASS |
| `resolveSafeAddress` rejects unsafe resolved IPs (IPv4/IPv6/mapped/mixed) | PASS |
| **DNS rebinding / TOCTOU:** connected host === validated host | PASS (spy on `tls.connect`/`net.connect` asserts host `8.8.8.8`) |
| Validation sees PUBLIC, transport would see PRIVATE → no socket opened | PASS |
| Cross-origin redirect → credential NOT leaked | PASS |
| Credential never sent to unsafe destination | PASS |

---

## 2. G1 — FALSE_GREEN_GATE (boundary-check.sh)

Before this fix, `book-core → ai/db` dependencies emitted **WARN** and exited
`0`, masking a known architecture blocker as a green gate.

- `scripts/boundary-check.sh` now emits `❌ FAIL (G1)` for `book-core depends on
  ai/db` and `book-core src/ has runtime imports of ai/db`, sets `FAIL=1`, and
  exits **non-zero**.
- Machine-readable final line: `GATE_STATUS: PASS | FAIL | DEFERRED_BY_EXPLICIT_DECISION`.
- `G1_DEFERRED=1` is honoured **only with explicit manager authorisation**; it
  was **NOT** set during this remediation.
- `scripts/release-gate-student-rag.ts` now runs `ssrf:adversarial` as a gate
  step, so a regressed R-4 transport fails the release gate.

> G1 remains a known blocker. It was **not** silently resolved this round (per
> the no-large-refactor constraint). The gate correctly reports FAIL when G1 is
> violated.

---

## 3. Verification evidence (canonical: pnpm 9.15.0)

| Check | Command | Result |
|---|---|---|
| Unit suite (ai package) | `pnpm --filter @ai-smartbook/ai test` | **780 passed** |
| SSRF adversarial suite | `pnpm run ai:test:ssrf` | **35 passed** |
| Boundary gate (no deferral) | `bash scripts/boundary-check.sh; echo $?` | **exit 1 (FAIL)** |
| Negative mutation (guard disabled) | `pnpm run ai:test:ssrf` | **exit 1 (FAIL)** — proves regression is caught |
| Boundary gate after restore | `bash scripts/boundary-check.sh; echo $?` | **exit 1 (FAIL)** — G1 unchanged |

The negative mutation (validation loop in `resolveSafeAddress` temporarily
removed) made `ai:test:ssrf` FAIL, confirming the suite catches a regressed
guard. The mutation was reverted and tests pass again. **No destructive mutation
was committed.**

---

## 4. Release-gate expected result

```
release-gate:student-rag == FAIL_DUE_TO_G1
```

The gate fails because `boundary-check.sh` reports G1 = FAIL. This is the
**correct** state: G1 is a real architecture blocker that has not been deferred
by a manager. The SSRF (`ssrf:adversarial`) step itself passes; the overall gate
is red solely due to G1.

---

## 5. Files changed

| File | Purpose |
|---|---|
| `packages/ai/src/rag/safe-url.ts` | `resolveSafeAddress()` — single validated-address source (runtime DNS + IP allowance). |
| `packages/ai/src/rag/pinned-fetch.ts` | Pinned transport: dials validated IP, TLS verify against original hostname. |
| `packages/ai/src/rag/cerebras.adapter.ts` | `executeWithRedirectControl()` uses pinned transport + cross-origin redirect rejection. |
| `packages/ai/test/rag/cerebras.adapter.test.ts` | Adapter tests inject a mock `transport`. |
| `packages/ai/test/rag/ssrf-adversarial.test.ts` | 35 adversarial tests incl. transport-level DNS binding. |
| `scripts/boundary-check.sh` | G1 = FAIL (not WARN); `GATE_STATUS` output. |
| `scripts/release-gate-student-rag.ts` | Adds `ssrf:adversarial` gate step. |
| `package.json` | Adds `ai:test:ssrf` script. |

---

## 6. Status

- PR #32 HEAD modified: **NO**
- PR #32 merged: **NO**
- PR #32 Ready: **NO**
- main pushed: **NO**
- G1 deferred: **NO**

Remediation branch and Draft PR delivered for independent (ChatGPT) acceptance.
Final implementation status: **READY_FOR_INDEPENDENT_REVIEW**.
