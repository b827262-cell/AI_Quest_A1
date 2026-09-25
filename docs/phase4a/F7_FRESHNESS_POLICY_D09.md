# F7 freshness policy — Owner D-09

Effective immediately, F7 freshness uses `max_age_hours = 72` and the Owner's
single holiday adjustment:

```text
effective_age_hours = max(0, actual_elapsed_hours - 24)
PASS iff effective_age_hours <= 72
```

The 24-hour adjustment is a one-time D-09 policy credit. It is not inferred
from a calendar, weekend, or repeated holiday condition, and no process may
apply it more than once. Therefore this decision has an actual elapsed-time
limit of 96 hours.

The supplied original timestamp `2026-09-22T07:16:40Z` is preserved byte for
byte as UTC. Its Asia/Taipei representation is `2026-09-22 15:16:40 +08:00`.
It must never be rewritten as 09/23. Every F7 run calculates its own `run_at`,
unmodified `actual_elapsed_hours`, and `effective_age_hours`; historic ages
are not reused.

## Supersession

The prior conclusion **"81.6h > 72h necessarily expired" is SUPERSEDED** for
this D-09 decision. It omitted the authorized one-time 24-hour credit. This
does not turn a fixture into live evidence and does not relax any other
fail-closed F7 check. A fresh control-plane SOT is still required after the
effective 96-hour limit.

`RELEASE_GATE=HOLD`; `SITES_DEPLOY=NO`.
