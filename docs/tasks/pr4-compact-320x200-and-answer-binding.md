@codex Please continue on `feat/pixel-match-thinking-progress` (PR #4). Do not merge `main`.

## New live evidence

A real provider request succeeded:

- Request ID: `guest_d6af6275a2954f69`
- Provider / Model: `openai / gpt-5.6-sol`
- Status: `success`
- Duration: `26043 ms`
- Finish reason: `stop`

This satisfies live-provider verification below 90 seconds only. It does not verify the 90-second or 150-second UI paths.

Evidence is recorded in `docs/validation/2026-08-03-live-openai-guest-d6af6275.md`.

## Task 1 — replace the large card with a native 320×200 compact card

The current progress card is clipped in the real frontend. Rebuild its layout so the rendered card is exactly `320px × 200px` at normal desktop/mobile scale, centered in the page.

Do not use `transform: scale(...)` on the existing 1248px card. Re-layout it natively.

Acceptance details are in `docs/reference/compact-thinking-progress-acceptance.md`.

All of the following must remain visible inside the 320×200 border:

- AI-SmartBook brand
- complete puzzle-head illustration, including particles
- `AI 思考中`
- short status subtitle
- numeric percentage
- full horizontal progress track and fill
- reminder text
- processing stage
- elapsed time
- stop control

Use `width: min(320px, calc(100vw - 24px))`; at normal width the outer card must be 320px and 200px high. No clipping, horizontal scroll, overflow outside the border, or hidden progress bar. Keep `ExtendedWaitDialog` separate and unconstrained by 320×200.

Add a compact DOM/fixture test for 15%, 68%, 99%, and 100%; retain `prefers-reduced-motion`.

## Task 2 — investigate possible stale frontend answer binding

The supplied frontend screenshots show **Lemonade Change with Python**, while backend Request ID `guest_d6af6275a2954f69` is **Farmer Latif with C++17**. Treat this as a possible stale-answer defect unless the screenshots are proven to be from separate runs.

Current `PublicHomePage` restoration logic sets `location.state.guestResponse`, then still fetches saved credentials and can overwrite that fresh response. Fix the binding so:

1. When `location.state.guestResponse` exists, render that exact request and do not overwrite it with a saved response for another request.
2. Saved-answer recovery is used on refresh/direct navigation when route state is absent.
3. If both exist, only accept the saved result when `saved.requestId === stateResponse.requestId`; otherwise ignore it and clear stale credentials.
4. Add tests where an older saved-response promise resolves after a newer route-state response; the older answer must never replace the new question/answer.
5. Bind displayed question, answer, and recovery credential to the same request ID.

Observation is documented in `docs/validation/2026-08-03-frontend-mismatch-observation.md`.

## Task 3 — legacy duplicate heading compatibility

The new backend parser removes section headings, but the supplied frontend still shows `題意摘要` twice. Verify deployed revision and API payload. Also make the renderer tolerant of historical saved `structuredAnswer` values:

- remove a leading pure `題意摘要` from `content.summary` before rendering;
- remove pure section labels from legacy step entries;
- do this as data normalization, not CSS hiding;
- preserve a meaningful summary and never render an empty duplicate section;
- add frontend tests for current and legacy payloads.

## Required validation

Run and report:

```bash
pnpm vitest run packages/ai apps/AI-Stu-R1
pnpm --filter AI-Stu-R1 typecheck
pnpm --filter AI-Stu-R1 lint
pnpm --filter AI-Stu-R1 build
pnpm --filter @ai-smartbook/ai typecheck
```

Return the new head SHA, changed files, test counts, and any remaining blocker. Do not describe the 90/150-second paths as live-verified unless a request actually crosses those thresholds.
