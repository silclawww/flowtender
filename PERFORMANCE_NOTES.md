# Stage 2 Performance Notes
_Last updated: 2026-04-23. Do not implement larger items without Sil review._

## Current timing (2026-04-23)
- stage2 end-to-end: 30–65s (was ~26s before IMP-04 added classify-workload)
- New bottleneck: extract-requirements-llm (~20-25s, reasoning model) + classify-workload (~10-15s, non-reasoning)
- These two LLM calls are sequential, not parallel

## Quick wins (safe, implement without review)
- [x] Remove `response_format: json_object` from classify-workload — was causing wrapping issue anyway
- [ ] Skip classify-workload when `item_count = 0` or `gaeb_positions` is empty (PDF-only tenders) — saves ~12s for those

## Medium items (review before implementing)
- **Parallelise classify-workload + generate-summary**: both can run after parse-requirements
  simultaneously — would save ~12s. Needs flowtender fan-out support or two separate branches.
- **Cache classify results**: if `gaeb_positions` hash unchanged on re-run, skip re-classification
- **Truncate classify-workload input earlier**: currently slices at 120 positions; for large LVs
  could sample representative subset instead (every Nth + all non-eigen signals)

## Larger items (significant refactor, do not implement yet)
- **Streaming responses**: stream LLM output to client so user sees progress vs. spinner
- **Stage 2 split**: separate requirements extraction from classification into two webhooks so
  details are available faster and classification runs in background
- **Model downgrade for requirements on simple tenders**: use non-reasoning model when
  item_count < 20 and pdf_text is short — save ~15s per tender
