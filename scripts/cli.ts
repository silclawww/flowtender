#!/usr/bin/env npx ts-node
/**
 * flowtender CLI
 * Usage:
 *   npx ts-node scripts/cli.ts list-workflows
 *   npx ts-node scripts/cli.ts run <workflowId> [--payload '{"tender_id":"..."}']
 *   npx ts-node scripts/cli.ts executions [--status error] [--limit 10]
 *   npx ts-node scripts/cli.ts show <executionId>
 *   npx ts-node scripts/cli.ts retry <executionId>
 */

const BASE_URL = process.env.FLOWTENDER_URL || 'http://localhost:3845';
const args = process.argv.slice(2);
const cmd = args[0];

async function apiFetch(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function formatDuration(ms?: number) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms/1000).toFixed(1)}s`;
}

function formatDate(iso?: string) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('de-DE');
}

async function main() {
  if (!cmd || cmd === 'help') {
    console.log(`flowtender CLI — http://localhost:3845
Commands:
  list-workflows              List available workflow definitions
  run <id> [--payload JSON]   Run a workflow synchronously
  executions [--status S]     List recent executions
  show <executionId>          Show execution detail with node runs
  retry <executionId>         Retry a failed execution
`);
    return;
  }

  if (cmd === 'list-workflows') {
    const wfs = await apiFetch('/api/flow/workflows') as Array<{id:string,name:string,description:string,nodes?:unknown[]}>;
    console.log(`\n${wfs.length} workflows:\n`);
    for (const wf of wfs) {
      console.log(`  ${wf.id}`);
      const nodeCount = wf.nodes?.length ?? 0;
      console.log(`    ${wf.name || '(unnamed)'} — ${nodeCount} nodes`);
      if (wf.description) console.log(`    ${wf.description}`);
    }
    return;
  }

  if (cmd === 'run') {
    const workflowId = args[1];
    if (!workflowId) { console.error('Usage: run <workflowId> [--payload JSON]'); process.exit(1); }
    const payloadIdx = args.indexOf('--payload');
    const payload = payloadIdx >= 0 ? JSON.parse(args[payloadIdx + 1]) : {};
    console.log(`Running workflow: ${workflowId}...`);
    const result = await apiFetch(`/api/flow/trigger/${workflowId}`, 'POST', payload);
    console.log('\nResult:', JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'executions') {
    const statusIdx = args.indexOf('--status');
    const status = statusIdx >= 0 ? args[statusIdx + 1] : undefined;
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? args[limitIdx + 1] : '10';
    const url = `/api/flow/executions?${status ? `status=${status}&` : ''}limit=${limit}`;
    const execs = await apiFetch(url) as Array<{id:string,workflow_id:string,status:string,duration_ms?:number,started_at:string,tender_id?:string,error?:string}>;
    console.log(`\n${execs.length} executions:\n`);
    for (const ex of execs) {
      const statusIcon = ex.status === 'done' ? '✓' : ex.status === 'error' ? '✗' : '⋯';
      console.log(`  ${statusIcon} ${ex.id.slice(0,8)} | ${ex.workflow_id} | ${formatDuration(ex.duration_ms)} | ${formatDate(ex.started_at)}`);
      if (ex.tender_id) console.log(`    tender: ${ex.tender_id}`);
      if (ex.error) console.log(`    error: ${ex.error}`);
    }
    return;
  }

  if (cmd === 'show') {
    const execId = args[1];
    if (!execId) { console.error('Usage: show <executionId>'); process.exit(1); }
    const exec = await apiFetch(`/api/flow/status/${execId}`) as {id:string,workflow_id:string,status:string,duration_ms?:number,node_runs:Array<{node_id:string,node_name:string,status:string,duration_ms?:number,error?:string,input:unknown[],output:unknown[][]}>};
    console.log(`\nExecution: ${exec.id}`);
    console.log(`Workflow:  ${exec.workflow_id}`);
    console.log(`Status:    ${exec.status}`);
    console.log(`Duration:  ${formatDuration(exec.duration_ms)}\n`);
    console.log('Node runs:');
    for (const nr of (exec.node_runs || [])) {
      const icon = nr.status === 'done' ? '✓' : nr.status === 'error' ? '✗' : '⋯';
      console.log(`  ${icon} [${nr.node_id}] ${nr.node_name} — ${formatDuration(nr.duration_ms)}`);
      if (nr.error) console.log(`    ERROR: ${nr.error}`);
    }
    return;
  }

  if (cmd === 'retry') {
    const execId = args[1];
    if (!execId) { console.error('Usage: retry <executionId>'); process.exit(1); }
    console.log(`Retrying execution: ${execId}...`);
    const result = await apiFetch(`/api/flow/retry/${execId}`, 'POST');
    console.log('New execution:', result);
    return;
  }

  console.error(`Unknown command: ${cmd}. Run 'help' for usage.`);
  process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
