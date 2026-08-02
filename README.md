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
correlation ID. Redacted telemetry has a seven-day TTL. A `pg_cron` job runs daily at
03:17 UTC and records only the purge date plus deleted execution/node-run counts in
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

The only unauthenticated operational endpoint is:

```text
GET /api/flow/health
```

It returns only `{"status":"ok"}` and no execution or customer metadata.

## License

MIT
