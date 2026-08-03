# Flowtender

A lightweight, self-hosted workflow automation engine purpose-built for construction tender processing. Flowtender replaces n8n with a focused, type-safe solution optimized for the tender pipeline.

## Purpose

Flowtender automates the 3-stage construction tender pipeline:

1. **Ingest** — Parse GAEB files, extract tender data, normalize formats
2. **Enrich** — Query external APIs, calculate costs, apply business rules
3. **Respond** — Generate quotes, send notifications, update systems

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Flowtender                           │
├─────────────────────────────────────────────────────────────┤
│  HTTP Triggers (webhooks, API calls)                        │
│         ↓                                                   │
│  Workflow Engine                                            │
│    • Loads workflow definitions (JSON)                      │
│    • Executes nodes in topological order                    │
│    • Tracks execution state per node                        │
│         ↓                                                   │
│  Node Executors                                             │
│    • code, http_request, supabase.*, switch, if, etc.       │
│         ↓                                                   │
│  Supabase (persistence + real-time)                         │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

- **`types/`** — Core type definitions for workflows and execution
- **`lib/runner/`** — Workflow execution engine
- **`lib/nodes/`** — Node type implementations
- **`lib/supabase/`** — Supabase client and utilities
- **`workflows/`** — Workflow definition JSON files
- **`app/`** — Next.js app (visual inspector + API routes)

### Visual Inspector

Flowtender includes a built-in visual inspector for debugging and monitoring workflow executions. Access it at:

```
http://localhost:3845
```

The inspector shows:
- Active and completed workflow runs
- Redacted stage-by-stage status and timing
- Safe error codes and correlation IDs

The inspector never exposes or stores trigger payloads, node input/output, prompts,
document contents, company profiles, or LLM responses. In non-local environments it
must be served over HTTPS. Browser access uses HTTP Basic auth with the fixed username
`operator` and `FLOWTENDER_OPERATOR_KEY` as the password. Inspector APIs and the CLI
use that same operator key as a Bearer token. Missing credentials fail closed.

## Getting Started

### Prerequisites

- Node.js 20.9+
- Supabase project (for persistence)

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
FLOWTENDER_API_KEY=a-strong-service-to-service-secret
FLOWTENDER_OPERATOR_KEY=a-different-strong-operator-secret
```

`FLOWTENDER_API_KEY` is only for authenticated Tenderly webhook/trigger calls.
`FLOWTENDER_OPERATOR_KEY` is only for the human inspector boundary. The credentials
are intentionally not interchangeable and neither falls back to the Supabase service
role key.

### Development

```bash
npm run dev
```

The app runs on port 3845 by default.

### Build

```bash
npm run build
```

### Security smoke test

Against a running local or staging instance:

```bash
FLOWTENDER_OPERATOR_KEY=... FLOWTENDER_API_KEY=... npm run test:integration -- http://localhost:3845
```

The smoke is non-destructive: it tests negative auth, the public health response,
credential separation, and authenticated webhook routing without running a workflow.

### Redacted telemetry retention and purge

Migration `002_secure_redacted_telemetry.sql` restricts both tracking tables to the
service role, removes payload-bearing columns, and limits telemetry to execution ID,
workflow/stage, tender ID, status, safe error code, timestamps, duration, and an opaque
correlation ID. Rows become eligible for automatic deletion once older than seven days.
A `pg_cron` job runs daily at 03:17 UTC, so with the scheduler operating normally,
telemetry is retained for less than eight days: the seven-day cutoff plus less than
24 hours until the next run. Missed or disabled scheduler runs can extend that window.
Each run records only the purge date plus deleted execution/node-run counts in
`flow_telemetry_purge_log`.

Existing telemetry is not automatically bulk-purged when the migration is applied.
After an operator has reviewed the target project, an explicit trusted SQL action is
required:

```sql
SELECT *
FROM public.purge_all_flow_telemetry('PURGE FLOWTENDER TELEMETRY');
```

The function does not return or export payloads. Do not invoke it casually or as part
of application startup. Stage-2 and stage-3 failures can be safely retried from their
tender ID; stage-1 failures require a fresh source upload because source payloads are
not retained.

Use [`docs/flowtender-telemetry-rollout.md`](./docs/flowtender-telemetry-rollout.md)
for the coordinated maintenance procedure. A disposable local Supabase database can
exercise the canonical shared overlay (`001`–`004`, then `016`–`019`), migration
retries, RLS/uniqueness, stale-claim isolation, browser-write grants, and purge-count
assertions with `npm run test:migration-db`; the script refuses non-local database URLs
and requires `FLOWTENDER_TEST_DATABASE_DISPOSABLE=YES` confirmation alongside
`FLOWTENDER_TEST_DATABASE_URL`.

Flowtender is the deployment source for this shared Supabase migration overlay.
Versions `005`–`015` belong to Tenderly's historical application schema and were
applied before the shared ledger was introduced; they must not be repaired, replayed,
or inferred from the numbering gap. Migrations `016`–`019` are byte-identical reviewed
mirrors of Tenderly's durable-processing and alert migrations.

### Pipeline admission limits

Migration `003_pipeline_admission.sql` provides the atomic per-user,
per-organisation, and retry-root admission gate shared by Tenderly and Flowtender.
Use [`docs/pipeline-admission-rollout.md`](./docs/pipeline-admission-rollout.md) for
the limit definitions, retention boundary, deployment order, and production smoke
checks. Do not deploy the two application changes independently outside that
maintenance procedure. `npm run test:migration-db` also runs the retry ceiling
through four independent PostgreSQL sessions and proves the actor/organisation
binding for retry roots.

### Production

```bash
npm run start
```

## Workflow Definition

Workflows are defined as JSON files in the `workflows/` directory. See [`workflows/README.md`](./workflows/README.md) for the full specification.

### Supported Node Types

| Type | Description |
|------|-------------|
| `code` | Execute custom JavaScript/TypeScript |
| `http_request` | Make HTTP requests |
| `supabase.query` | Query Supabase |
| `supabase.upsert` | Upsert to Supabase |
| `supabase.update` | Update Supabase records |
| `switch` | Multi-way conditional routing |
| `if` | Binary conditional |
| `wait` | Pause execution |
| `respond` | HTTP response |
| `gaeb_parse` | Parse GAEB tender files |

## HTTP Triggers

Workflows can be triggered via HTTP:

```bash
POST /api/flow/trigger/:workflow_id
Authorization: Bearer $FLOWTENDER_API_KEY
Content-Type: application/json

{
  "tender_id": "abc123",
  "file_url": "https://..."
}
```

Webhook and direct-trigger JSON ingress is capped at exactly 4,250,000 bytes
from both the declared `Content-Length` and bytes counted while streaming. This
matches Tenderly's outbound JSON cap and leaves margin below Vercel's 4,500,000-
byte request-body ceiling. Tenderly's source-file limit is 3,000,000 bytes; the
encoded file and all JSON overhead must still fit within the 4,250,000-byte
request cap. Requests that cross it stop before JSON parsing, admission claims,
telemetry, workflow loading, or paid provider work.

### Deployed limit proof

`npm run probe:deployed-limits` is the destructive-but-self-cleaning operator
proof for the two documented limits. It creates one confirmed disposable auth
user and personal organisation, uploads a structurally valid 3,000,000-byte
PDF through the real Tenderly route, verifies completed Stage 1 telemetry, and
then proves the 3,000,001-byte rejection made no scoped database changes. It
also sends valid JSON bodies of exactly 4,250,000 and 4,250,001 bytes to an
unknown authenticated Flowtender webhook and expects the normal 404 followed
by a pre-routing 413.

The probe prints only status codes, byte counts, zero-delta assertions, and
cleanup state. In `finally`, an owner `psql` connection deletes the exact
disposable telemetry, admission, tender, organisation, membership, and profile
rows before the auth-admin user is deleted. Credentials are read only from the
environment. Never redirect shell tracing or secret-bearing environment output
into the evidence record.

Required inputs:

```text
P04_PROBE_CONFIRM=CREATE_AND_DELETE_DISPOSABLE_P04_ROWS
P04_PROBE_TENDERLY_ORIGIN=https://<deployed-tenderly-origin>
P04_PROBE_FLOWTENDER_ORIGIN=https://<deployed-flowtender-origin>
P04_PROBE_SUPABASE_URL=https://<project-ref>.supabase.co
P04_PROBE_SUPABASE_ANON_KEY=<anon-key>
P04_PROBE_SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
P04_PROBE_FLOWTENDER_API_KEY=<Tenderly-to-Flowtender-key>
P04_PROBE_DATABASE_URL=<owner-or-postgres-connection-url>
```

Prefer a short-lived database URL captured in memory from
`supabase db dump --linked --schema public --dry-run`. Pass the parsed URL only
to the probe process; do not print it, paste it into this repository, or save it
to a shell file. The probe accepts that command's `cli_login_postgres` identity
only on this project's exact direct database host with the existing TLS checks,
and applies Supabase's matching `role=postgres` session setting only for that
short-lived identity.

For a protected Vercel preview, also set either or both linked checkout paths;
the script then uses `vercel curl` for that target so preview protection remains
enabled. The temporary curl configuration is mode `0600` and is deleted by the
same `finally` cleanup.

```text
P04_PROBE_TENDERLY_VERCEL_CWD=/absolute/path/to/linked/tenderly/checkout
P04_PROBE_FLOWTENDER_VERCEL_CWD=/absolute/path/to/linked/flowtender/checkout
```

Run the proof from an untraced shell after both origins have the intended
builds and point to the same Supabase project:

```bash
npm run probe:deployed-limits
```

Roll out in dependency order: verify Flowtender's exact JSON ingress on its
preview first; promote Flowtender; then run this full proof with the Tenderly
preview and promoted Flowtender origin. Promote Tenderly only after all four
checks and all three cleanup fields report success. Finally repeat the full
proof against both production origins and retain only the emitted JSON.

The only unauthenticated operational endpoint is:

```text
GET /api/flow/health
```

It returns only `{"status":"ok"}` and no execution or customer metadata.

## License

MIT
