# A-01 coverage aggregator

Reads a **sanitized** `relay.verify` JSON-Lines summary and reports the A-01
72h coverage picture. It is the reporting counterpart to
`scripts/a01-synthetic/`: the injector tops up per-path coverage; this tool
shows whether the window meets its targets.

It never reads or writes raw log lines, PII or secrets — only aggregate counts.

## Input

Newline-delimited JSON (one event per line) with the fields documented in
`docs/ops/relay-rollout.md` §4.4:

```
evt, result, site, mode, identityPresent, method, pathClass, synthetic
```

An optional `route` (route template, e.g. `/api/admin/books/[id]`) may be added
when the summary was cross-referenced with platform invocation data. Without it,
per-path checks are reported as `undeterminable` (see below).

Malformed lines are **counted**, never silently dropped (`source.parse_errors`).

## Usage

```bash
node scripts/a01-coverage/aggregate.mjs --input summary.jsonl
node scripts/a01-coverage/aggregate.mjs --input summary.jsonl --json --out report.json
cat summary.jsonl | node scripts/a01-coverage/aggregate.mjs --input -
```

Exit codes: `0` success, `2` a hard gate failed (parse errors, a zero-tolerance
violation, or a non-zero coverage-equation difference), `1` usage error.

## What it reports

- **Natural vs synthetic valid counts**, per site (always separate).
- **pathClass x method counts** (natural / synthetic / total).
- **Student valid >= 300 / Admin valid >= 100** — **natural only**; synthetic
  samples never count toward these totals.
- **Each applicable non-GET path x verb >= 30** — counted as natural +
  synthetic (synthetic only supplements). Requires a `route` field; without one
  the status is `undeterminable` with a reason, matching the runbook rule that
  `pathClass` alone cannot distinguish sub-routes.
- **Zero-tolerance**: `result=invalid` count and
  `result=none && identityPresent=true` count; `ok` is true only when both are 0.
- **Coverage equation (PROPOSAL ONLY)** — see below.

Applicable non-GET path x verb rows (default; override via the API):

| Site | Route | Method |
| --- | --- | --- |
| student | `/api/student/progress` | PUT |
| admin | `/api/admin/books` | POST |
| admin | `/api/admin/books` | DELETE |
| admin | `/api/admin/books/upload` | POST |
| admin | `/api/admin/books/[id]` | DELETE |

## Coverage equation — proposal, unconfirmed

```
ingress_total = verify + probe_stripped + health + books + sync + cors + static
difference must be 0
```

This identity is a **proposal**. It is **not confirmed by the Owner**, and every
output carries the label `proposal, unconfirmed (not confirmed by Owner)`. It is
implemented from configurable inputs:

```json
{ "ingressTotal": 10, "buckets": { "verify": 4, "probeStripped": 2, "health": 1, "books": 1, "sync": 1, "cors": 1, "static": 0 } }
```

Pass it with `--equation eq.json`. Bucket names default to the proposal set and
can be overridden by supplying your own `buckets` keys.

## Privacy

No raw log line, request content, id, IP or secret is read or written. The report
contains counts, route templates and the line numbers of parse errors only.

## Tests

```bash
node --test scripts/a01-coverage/a01-coverage.test.mjs
```

Covers parsing/validation, the natural/synthetic split, the 300/100 and per-path
thresholds, zero-tolerance counting, the equation, and the full report build.
