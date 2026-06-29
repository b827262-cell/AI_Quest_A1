# Phase 2 Fourth Slice Kickoff: ICO 5×5 Learning Grid MVP

Date: 2026-06-29

## Current state

### Current stable tags
- `phase1-pdf-mobile-pass-20260629`
- `phase2-progress-mvp-pass-20260629`
- `phase2-knowledge-points-mvp-pass-20260629`

### Completed phases
- Phase 1 PDF/mobile/proxy PASS
- Phase 2 Reader Toolbar PASS
- Phase 2 Progress / Completion MVP PASS
- Phase 2 Knowledge Points MVP PASS

## New target
**Phase 2 Fourth Slice — ICO 5×5 Learning Grid MVP**

## Scope
- Show 5×5 learning grid
- Maximum of 25 cells
- Cells derived from:
  - Knowledge Points
  - Or chapter-derived fallback points when knowledge points are absent
- Completed knowledge points render in completed state
- Clicking a cell opens Knowledge Point detail
- Mobile grid is usable and does not permanently cover PDF content

## Explicit out of scope
- Achievement Points
- Coins / score / badges / streaks
- AI-generated quiz
- Screenshot Ask AI
- Admin authoring
- DRM claims

## Security constraints
- PDF remains through `pdf-view`
- No raw `/uploads/books` usage in this slice
- No local file paths in API or UI payload behavior
- Security statements remain best-effort protection wording only
