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
- Node-by-node execution details
- Input/output data for each step
- Timing and error information

## Getting Started

### Prerequisites

- Node.js 18+
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
```

### Development

```bash
npm run dev
```

The app runs on port 3845 by default.

### Build

```bash
npm run build
```

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
POST /api/workflows/:workflow_id/trigger
Content-Type: application/json

{
  "tender_id": "abc123",
  "file_url": "https://..."
}
```

## License

MIT
