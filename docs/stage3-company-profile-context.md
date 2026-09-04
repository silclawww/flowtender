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

Every non-review eligibility judgment must cite one to eight non-empty fields
from the prepared profile and include a bounded assessment reason. The first
pass, repair inspector, fallback, and final parser all enforce the same
contract. An unavailable or invented field triggers the single bounded repair;
if no defensible judgment survives, the fallback is `needs_review`. This makes
profile-based fit claims inspectable without exposing internal profile IDs.

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

## Evaluation methodology

Stage 3 remains model-judged rather than a hard-coded rules engine, but both
the first pass and the single repair pass now follow the same fixed sequence:

1. judge every requirement only from its allowed direct profile evidence;
2. label the decisive dependencies as confirmed evidence, an open evidence
   check, or a confirmed deviation;
3. calculate strategic fit from one five-dimension worksheet; and
4. derive the bid recommendation from the validated requirement states.

The worksheet allocates 25 points to trade/scope fit, 20 to capacity and
project-size fit, 15 to region and delivery-model fit, 25 to references and
qualifications, and 15 to execution/value-creation fit. Its neutral anchors sum
to 50. The model may raise a dimension only for concrete positive evidence and
lower it only for confirmed contrary evidence or a concrete execution burden.
Missing profile evidence and `needs_review` remain neutral rather than becoming
invented negative evidence. This preserves intelligent judgment inside each
dimension while giving repeated runs the same order, anchors, and thresholds.
The model returns all five component values; the workflow rejects a value
outside its dimension range or a headline score that is not their exact sum.

Risks use a matching evidence vocabulary and stable priority: confirmed
blockers first, then critical submission-time checks, material operational or
competitive uncertainty, and finally minor optimisation. A `needs_review`
item must be described as open, never as confirmed missing. `high` is reserved
for a confirmed blocker or an open item whose source explicitly says failure
causes exclusion; otherwise material uncertainty is `medium`.

## Read-only shadow evaluations

`npm run shadow:stage3 --` runs one Stage 3 comparison with a chosen source
tender and company profile. It reads those two rows, then executes the exact
production preparation, evidence attachment, prompt, validation, routing,
optional one-call repair, parser, evidence policy, no-LV finalisation, and
evaluation-metadata nodes in memory. The same 200,000-character coverage
contract is enforced. It never executes the workflow trigger, admission,
telemetry, stage-claim, or `save-evaluation` node.

```sh
npm run shadow:stage3 -- \
  --tender TENDER_UUID \
  --source-org SOURCE_ORG_UUID \
  --profile-org PROFILE_ORG_UUID \
  --profile-label comparison_label \
  --output-dir /absolute/private/path
```

The output directory must be absolute and outside the repository. Artifacts
are created without overwrite permission (`wx`) at mode `0600`; the directory
must grant no group or public access (`0700` or stricter). Each artifact records
the workflow and input hashes, exact executed node list, model-call count,
prepared model input, and final shadow output. The database access in the
operator CLI is select-only.
