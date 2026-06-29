# Phase 2 Third Slice Kickoff: Knowledge Points MVP

Date: 2026-06-29

## Current state

### Current stable tags
- `phase1-pdf-mobile-pass-20260629`
- `phase2-progress-mvp-pass-20260629`

### Completed phases
- Phase 1 PDF/mobile/proxy PASS
- Phase 2 Reader Toolbar PASS
- Phase 2 Progress / Completion MVP PASS
- Latest final smoke report: `13b45c9 docs(r2): record progress MVP final smoke test`

## New target

### Phase 2 Third Slice — Knowledge Points MVP

## Scope
- Knowledge Points API
- Knowledge Points Reader Panel
- Page/chapter-related knowledge points
- Mark knowledge point learned/completed
- Empty state if no knowledge points exist

## Out of scope
- ICO 5×5
- Achievement Points
- Screenshot Ask AI
- Large schema migration unless required
- DRM claims

## Security constraints
- Keep PDF rendering through `pdf-view`
- No raw `/uploads/books`
- No local file paths exposed
- Apply best-effort protection wording only

## Notes
- No application code changes are planned in this phase kickoff report. This report only documents scope and sequencing for the next slice implementation.
