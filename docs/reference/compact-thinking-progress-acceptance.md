# Compact thinking progress acceptance

Target rendered card size: `320px × 200px` CSS pixels.

The compact card must render natively at this size. Do not scale down the 1248px desktop card with CSS `transform: scale(...)`.

Required visible elements:

- AI-SmartBook brand mark and name
- puzzle-head progress illustration with colored completed region and pale incomplete region
- `AI 思考中`
- short status subtitle
- numeric percentage
- complete horizontal progress bar
- short reminder line
- current processing stage
- elapsed time
- stop control while the request is active

The card must have no clipped text, clipped SVG, horizontal scrolling, or content outside its border at 320×200. At widths below 320px, use `width: min(320px, calc(100vw - 24px))` while preserving the complete layout.

Recommended layout:

- card: 320×200, 10–12px padding, 16–18px radius
- brand row: 20–22px high
- content grid: approximately 104px illustration + flexible copy column
- puzzle SVG: approximately 96–108px square
- title: 22–26px
- subtitle: 10–11px, maximum two lines
- percentage: 30–36px
- progress track: 16–20px high
- reminder and status: 9–10px

The 90-second extended-wait dialog remains a separate overlay and is not constrained to 320×200.
