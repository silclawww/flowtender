# Stage 3 company-profile context

Stage 3 sends the complete set of stored business fields that can affect tender
fit. It deliberately excludes database ownership and onboarding metadata.

## Evaluation fields

The following fields were already present in the production evaluation context:

- `name`
- `trades`
- `regions`
- `service_types`
- `certifications`
- complete `project_references`
- `hq_street`, `hq_postal_code`, and `hq_city`

This change adds the previously omitted stored fields:

- `founded_year`
- `team_size`
- `annual_turnover_eur`
- `project_size_min_eur` and `project_size_max_eur`
- `trade_capacities`
- `insurances`
- `policies`
- `project_references_state`

`capabilities_summary` was removed from the context because no such
`company_profiles` column exists. Internal `id`, `org_id`, `user_id`, onboarding
progress, and timestamps are not tender-fit evidence and are never sent to the
model.

Only reference rows with a non-empty client and project count as usable
evidence. At least one usable row makes the effective state `provided`.
Otherwise the stored `explicitly_absent` state is preserved; every other state
is treated as `not_provided`.

## Missing evidence

Empty, null, or absent profile values mean “not provided,” not “confirmed
missing.” The first-pass and reconciliation prompts apply that rule. Unknown
reference evidence is also normalised after the model call to non-blocking
`needs_review`; explicitly absent references become `not_met` and block only a
critical source requirement.

## Context and source coverage

Stage 3 serialises every persisted requirement unchanged; neither requirements
nor profile fields are sliced to make room. On 2026-08-25, the two real profiles
serialised to approximately 0.7 KiB (Willibald) and 1.3 KiB (Test01), while the
two customer requirement arrays were approximately 1.7–1.9 KiB. This is far
below the existing HTTP body and model-context ceilings.

This does not remove the separate Stage 2 extraction limit. Both 2026-08-25
Willibald tenders already carry `requirements_coverage.source_truncated = true`:
roughly 32,000 selected source characters existed, while 12,000 were used for
requirement extraction. Stage 3 remains conservative (`needs_review`) for that
state. Shadow comparisons must distinguish profile effects from this upstream
coverage limitation.
