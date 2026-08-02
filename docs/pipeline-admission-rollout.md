# Pipeline admission rollout

Migration `003_pipeline_admission.sql` adds the shared, durable admission gate
used by Tenderly uploads and Stage 2/3 calls, plus Flowtender operator retries.
The ledger contains only actor, organisation, operation, lease, and retry-root
identifiers. It never stores customer payloads, prompts, documents, or secrets.

## Limits

The migration is the source of truth for the pilot limits:

- one active pipeline request per user;
- two active pipeline requests per organisation;
- 12 admitted requests per user per rolling hour;
- 40 admitted requests per organisation per rolling hour;
- two retries per root execution per rolling 24 hours;
- 12-minute self-expiring leases.

Retry acquisition takes a transaction-scoped advisory lock for the immutable
root before the user and organisation locks. The root must belong to an original,
claimed Stage 2/3 execution for the same actor and organisation. This makes the
two-retry ceiling global even when requests race through different processes.

## Lease ownership and handoff

- Tenderly acquires exactly one upload lease before buffering or parsing. The
  Flowtender Stage 1 receiver claims it before telemetry, workflow loading,
  database access, or LLM work, but deliberately does not release it.
- A complete synchronous Stage 1 response transfers ownership back to Tenderly.
  Tenderly keeps that original lease active through its existing supplemental
  211/214 extraction and final local reads/writes, then releases it. It never
  performs a second acquisition, including for the twelfth hourly request.
- If dispatch is aborted or the response body is lost, ownership is ambiguous:
  Tenderly does not release and the 12-minute TTL closes the lease. There is no
  direct-database/LLM fallback after dispatch.
- For Stage 2, Stage 3, and retry, Flowtender owns the claimed lease and releases
  it in a receiver-side `finally` only after all workflow and telemetry mutations
  settle. Tenderly and the retry route never release after dispatch.

Rows become purge-eligible after 48 hours. A daily `pg_cron` sweep runs at
03:41 UTC, so normal retention is under 72 hours. A disabled or missed scheduler
run can extend that period and must alert the operator.

## Coordinated deployment

This boundary must be rolled out in a short maintenance window. Deploying new
Tenderly before new Flowtender would let the old runner ignore the lease; deploying
new Flowtender first intentionally rejects old callers until Tenderly follows.

1. Configure distinct, non-empty `FLOWTENDER_API_KEY` and
   `FLOWTENDER_OPERATOR_KEY` values in Flowtender. Confirm neither equals the
   Supabase service-role key.
2. Put upload, Stage 2/3, and operator retry ingress into maintenance mode. Wait
   until no pipeline execution is running.
3. Apply migration `003_pipeline_admission.sql` to the intended Supabase project.
4. Verify forced RLS, the exact service-role grants, all three admission RPCs,
   and the scheduled `flowtender-pipeline-admission-ttl` job.
5. Deploy Flowtender, then deploy Tenderly immediately afterward.
6. Run the negative and positive checks below before reopening ingress.
7. Resume traffic and monitor safe admission-denial codes plus scheduler health.

Repository history shows that older Flowtender code could accept the Supabase
service-role key as a fallback, but no tracked Tenderly sender uses that key as a
bearer credential. Before production rollout, also inspect deployment variables and
available access history. If they show reuse or transmission, rotate the service-role
key everywhere before revoking the old value; otherwise record that rotation was not
required.

Rollback is application-only: return both applications to the previous compatible
versions while ingress remains closed. Leave migration `003` in place; it is
forward-only and does not alter Flowtender telemetry tables.

## Required smoke checks

- Missing, empty, malformed, wrong, operator, and Supabase service-role bearer
  values receive `401` and create no execution.
- The dedicated service key reaches webhook routing; the operator credential does
  not. The service key cannot reach inspector APIs.
- A missing, expired, already claimed, or context-mismatched lease fails before
  telemetry, tender mutation, workflow nodes, or LLM calls.
- One authorised upload and one same-organisation Stage 2/3 sequence complete.
- A second concurrent user request and excess hourly requests receive the safe
  `PIPELINE_LIMITED` response with no partial tender or execution state.
- A failed Stage 2/3 execution can be retried twice; a third retry for the same
  immutable root is denied before paid work. A root owned by another actor or
  organisation is rejected as unavailable.
- Four concurrent retry transactions across two valid principals sharing one
  test root admit exactly two total requests. The disposable-database test runs
  this as four independent PostgreSQL sessions.
- Eleven released requests followed by one complete upload plus supplemental
  extraction use twelve admissions total; no second lease is acquired for the
  supplemental step, and the next request is denied by the hourly boundary.
- The admission ledger exposes no rows to `anon` or `authenticated`, contains only
  allowlisted metadata, and the scheduled purge produces the expected row count.

## Pilot signup gate

Source code removes self-registration and prevents magic-link login from creating
users. Before opening the pilot, also set Supabase Auth `disable_signup=true`, set
the canonical HTTPS site URL and redirect allow-list, and verify direct Auth signup
is denied while an approved invited user can still complete login.
