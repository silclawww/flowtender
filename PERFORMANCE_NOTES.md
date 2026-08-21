# Stage 2 Performance Notes

_Last updated: 2026-08-21._

## Production baseline

The non-customer `Test01` run on 2026-08-20 contained 209 positions. Stage 2
took 63.753s, including 33.704s in `classify-workload` and 10.473s in
`reconcile-workload-groups-llm`. The run had zero errors and zero retries.

## Bounded chunk concurrency

The 209-position workload produces two existing model chunks. Only
`classify-workload` opts into `max_concurrency: 2`; every other batched HTTP
node keeps the sequential default.

The versioned deterministic fixture in `tests/fixtures/stage2-performance.json`
measured 124.2ms sequential versus 63.4ms concurrent locally, a 49% scheduler
reduction. It verifies the same two provider calls and byte-equivalent ordered
outputs. Existing workflow regressions continue to enforce exact source-ID
coverage, code-derived arithmetic, all positions, and reconciliation behavior.

This is scheduler evidence, not a claimed provider-production timing. Record the
real before/after node timing on the next normal or explicitly approved upload.

## Constraints

Do not trade quality for latency through sampling, truncation, a weaker model,
skipping required reconciliation, extra provider calls, or keyword/regex
classification. Parallelising independent Stage 2 branches remains a larger
runner change and should be considered only if this bounded optimisation is
insufficient after deployed measurement.
