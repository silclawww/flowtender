# Sprint Log — sprint-20260324-0620

**Objective:** Build flowtender — lightweight workflow runner replacing n8n for Tenderly's pipeline  
**Repo:** silclawww/flowtender  
**Started:** 2026-03-24T06:20:00Z  
**Target Duration:** 8 hours

---

## Initial WBS (25 tasks)

| # | Title | Type | Depends On | Status |
|---|-------|------|------------|--------|
| 0 | Core type definitions + project structure | build | — | ⏳ Pending |
| 1 | Supabase client setup + migration 001 | db | 0 | ⏳ Pending |
| 2 | WorkflowLoader — load + validate workflow JSON | build | 0 | ⏳ Pending |
| 3 | Node executor — code (inline JS) | build | 0 | ⏳ Pending |
| 4 | Node executor — http_request | build | 0 | ⏳ Pending |
| 5 | Node executor — supabase (query/upsert/update) | build | 0,1 | ⏳ Pending |
| 6 | Node executor — switch + if + wait + respond | build | 0 | ⏳ Pending |
| 7 | Core WorkflowRunner engine | build | 1,2,3,4,5,6 | ⏳ Pending |
| 8 | HTTP trigger API route | build | 7 | ⏳ Pending |
| 9 | Workflow def — Stage 1 GAEB path | build | 2 | ⏳ Pending |
| 10 | Workflow def — Stage 1 PDF path | build | 2 | ⏳ Pending |
| 11 | Workflow def — Stage 2 requirements | build | 2 | ⏳ Pending |
| 12 | Workflow def — Stage 3 evaluation | build | 2 | ⏳ Pending |
| 13 | Main trigger API route — smart routing | build | 7,8 | ⏳ Pending |
| 14 | Inspector UI — executions list | build | 1 | ⏳ Pending |
| 15 | Inspector UI — execution detail + node timeline | build | 8,14 | ⏳ Pending |
| 16 | Update Tenderly upload route → flowtender | integration | 13 | ⏳ Pending |
| 17 | Update Tenderly store → flowtender Stage 2+3 | integration | 13 | ⏳ Pending |
| 18 | PM2 setup + local deployment | config | 8,13,14 | ⏳ Pending |
| 19 | End-to-end test — .avasign upload | test | 16,17,18 | ⏳ Pending |
| 20 | Summary field generation in Stage 2 | build | 11 | ⏳ Pending |
| 21 | Retry mechanism | build | 15 | ⏳ Pending |
| 22 | Workflow canvas — Mermaid diagram | build | 15 | ⏳ Pending |
| 23 | Install pdf-parse in flowtender | config | 3 | ⏳ Pending |
| 24 | Workflow node — gaeb-parse | build | 3 | ⏳ Pending |

---

## Sprint Complete — 2026-03-24T07:04Z

**Duration:** ~44 minutes (of 8-hour budget)
**Tasks Completed:** 25/25 (100%)
**Final Build:** ✅ Passing

### What Was Built

**Core Engine:**
- WorkflowRunner with BFS topological execution
- Node executors: code, http_request, supabase (query/upsert/update), switch, if, wait, respond, gaeb_parse
- Workflow JSON loader with validation

**API Layer:**
- `POST /api/flow/trigger/[workflowId]` — direct workflow trigger
- `POST /api/flow/webhook/[path]` — n8n-compatible webhook routing
- `GET /api/flow/executions` — list all executions
- `GET /api/flow/status/[id]` — execution detail with node runs
- `POST /api/flow/retry/[id]` — retry failed executions

**Workflows (3 Tenderly Pipeline Stages):**
- `tender-stage1-gaeb.json` — GAEB/archive metadata extraction
- `tender-stage1-pdf.json` — PDF metadata extraction via LLM
- `tender-stage2-requirements.json` — Requirements extraction + summary generation
- `tender-stage3-evaluation.json` — Bid evaluation with **real company profiles** (not n8n mock!)

**Inspector UI:**
- Executions list with auto-refresh
- Execution detail with node timeline
- Mermaid workflow diagram with status coloring
- Retry button for failed executions

**Tenderly Integration:**
- Upload route calls flowtender Stage 1
- `/api/tender/details` calls flowtender Stage 2
- `/api/tender/evaluation` calls flowtender Stage 3
- Graceful fallback if flowtender unreachable

**Infrastructure:**
- PM2 ecosystem config for flowtender on port 3845
- Supabase tables: `flow_executions`, `flow_node_runs`

### End-to-End Test Result

✅ Real `.avasign` file uploaded → Stage 1 completed in 4.7s → Tender "Neubau 4 Züge und Sporthalle" created with 230 items

### Key Improvements Over n8n

1. **Real company profiles** — Stage 3 loads from Supabase instead of hardcoded mock
2. **Summary generation** — Stage 2 now generates project summaries
3. **Full observability** — Every node run logged with input/output JSON
4. **Retry mechanism** — Failed executions can be retried with exponential backoff
5. **Visual workflow diagram** — Mermaid renders workflow shape with status colors
6. **I own it** — No external service dependency, full control over the pipeline

---

## Cycle Log

_Sprint started 2026-03-24T06:20Z. 25 tasks generated. All tasks completed by 07:04Z._
