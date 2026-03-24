# Workflows Directory

This directory contains workflow definition JSON files.

## Workflow JSON Format

Each workflow is defined as a JSON file with the following structure:

```json
{
  "id": "unique-workflow-id",
  "name": "Human-readable workflow name",
  "description": "Optional description of what the workflow does",
  "version": "1.0.0",
  "nodes": [...],
  "edges": [...]
}
```

### Nodes

Nodes are the building blocks of a workflow. Each node has:

- `id`: Unique identifier within the workflow
- `type`: The node type (see supported types below)
- `name`: Human-readable name for the node
- `config`: Type-specific configuration object
- `position`: Optional `{ x, y }` coordinates for visual editor

### Supported Node Types

| Type | Description |
|------|-------------|
| `code` | Execute custom JavaScript/TypeScript code |
| `http_request` | Make HTTP requests to external APIs |
| `supabase.query` | Query data from Supabase |
| `supabase.upsert` | Insert or update data in Supabase |
| `supabase.update` | Update existing data in Supabase |
| `switch` | Route execution based on multiple conditions |
| `if` | Conditional branching (true/false) |
| `wait` | Pause execution for a specified duration |
| `respond` | Send HTTP response (for webhook workflows) |
| `gaeb_parse` | Parse GAEB construction tender files |

### Edges

Edges connect nodes and define the execution flow:

- `from`: Source node ID
- `from_output`: Output index from the source node (0-based)
- `to`: Target node ID
- `to_input`: Optional input index on the target node

### Example

```json
{
  "id": "tender-processor",
  "name": "Process Incoming Tender",
  "nodes": [
    {
      "id": "parse",
      "type": "gaeb_parse",
      "name": "Parse GAEB File",
      "config": { "input_field": "file_url" }
    },
    {
      "id": "store",
      "type": "supabase.upsert",
      "name": "Store Tender",
      "config": { "table": "tenders" }
    }
  ],
  "edges": [
    { "from": "parse", "from_output": 0, "to": "store" }
  ]
}
```
