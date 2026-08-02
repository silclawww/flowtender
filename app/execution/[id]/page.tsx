'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { MermaidDiagram } from '@/app/components/MermaidDiagram';
import { workflowToMermaid, type NodeStatus } from '@/lib/workflow-to-mermaid';
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from '@/types/workflow';

interface NodeRun {
  execution_id: string;
  stage: string;
  status: string;
  safe_error_code?: string;
  correlation_id: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

interface Execution {
  id: string;
  workflow_id: string;
  status: string;
  tender_id?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  safe_error_code?: string;
  correlation_id: string;
  node_runs: NodeRun[];
}

interface WorkflowResponse {
  id: string;
  name: string;
  description?: string;
  version?: string;
  nodes: Omit<WorkflowNode, 'config'>[];
  edges: WorkflowEdge[];
  error?: string;
}

const TENDER_SERVER = 'http://100.116.26.90:3844';

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'bg-amber-100 text-amber-800',
    done: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
    pending: 'bg-zinc-100 text-zinc-700',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status] || styles.pending}`}
    >
      {status}
    </span>
  );
}

function NodeStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />;
    case 'done':
      return <CheckCircle2 className="w-4 h-4 text-green-600" />;
    case 'error':
      return <XCircle className="w-4 h-4 text-red-600" />;
    default:
      return <Clock className="w-4 h-4" style={{ color: '#71717A' }} />;
  }
}

function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-zinc-200 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-600" />
      ) : (
        <Copy className="w-3.5 h-3.5" style={{ color: '#71717A' }} />
      )}
    </button>
  );
}

function NodeRunRow({ nodeRun }: { nodeRun: NodeRun }) {
  return (
    <div
      className="border-b"
      style={{ borderColor: '#E4E4E7' }}
    >
      <div
        className="flex items-center justify-between py-3 px-4"
      >
        <div className="flex items-center gap-3">
          <NodeStatusIcon status={nodeRun.status} />
          <div>
            <div className="text-sm font-medium" style={{ color: '#09090B' }}>
              {nodeRun.stage}
            </div>
            <div className="text-xs" style={{ color: '#71717A' }}>
              Stage
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <StatusBadge status={nodeRun.status} />
          <span className="text-sm" style={{ color: '#71717A' }}>
            {formatDuration(nodeRun.duration_ms)}
          </span>
        </div>
      </div>

      {nodeRun.status === 'error' && nodeRun.safe_error_code && (
        <div className="px-4 pb-3">
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            Error code: <code>{nodeRun.safe_error_code}</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExecutionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const executionId = params.id as string;

  const [execution, setExecution] = useState<Execution | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const fetchExecution = useCallback(async () => {
    try {
      const res = await fetch(`/api/flow/status/${executionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExecution(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  // Fetch workflow definition when execution is loaded
  useEffect(() => {
    if (!execution?.workflow_id) return;

    fetch(`/api/flow/workflows/${execution.workflow_id}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) {
          setWorkflow(data);
        }
      })
      .catch(() => {
        // Silently ignore workflow fetch errors - diagram just won't show
      });
  }, [execution?.workflow_id]);

  useEffect(() => {
    fetchExecution();
  }, [fetchExecution]);

  useEffect(() => {
    if (!execution || execution.status !== 'running') return;

    const interval = setInterval(fetchExecution, 3000);
    return () => clearInterval(interval);
  }, [execution, fetchExecution]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/flow/retry/${executionId}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.new_execution_id) throw new Error(data.error_code || 'Retry failed');
      router.push(`/execution/${data.new_execution_id}`);
    } catch (err) {
      setError(String(err));
      setRetrying(false);
    }
  };

  // Build node status map from node_runs
  const getNodeStatuses = useCallback((): Record<string, NodeStatus> => {
    if (!execution?.node_runs) return {};
    const statuses: Record<string, NodeStatus> = {};
    for (const run of execution.node_runs) {
      // Map status string to NodeStatus type
      const status = run.status as NodeStatus;
      if (['pending', 'running', 'done', 'error'].includes(status)) {
        statuses[run.stage] = status;
      }
    }
    return statuses;
  }, [execution?.node_runs]);

  // Generate Mermaid chart
  const getMermaidChart = useCallback((): string | null => {
    if (!workflow) return null;

    // Convert WorkflowResponse to WorkflowDefinition (add empty config)
    const workflowDef: WorkflowDefinition = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      nodes: workflow.nodes.map((n) => ({
        ...n,
        config: {},
      })),
      edges: workflow.edges,
    };

    return workflowToMermaid(workflowDef, getNodeStatuses());
  }, [workflow, getNodeStatuses]);

  // Calculate stats
  const stats = execution?.node_runs
    ? {
        total: execution.node_runs.length,
        passed: execution.node_runs.filter((n) => n.status === 'done').length,
        failed: execution.node_runs.filter((n) => n.status === 'error').length,
        running: execution.node_runs.filter((n) => n.status === 'running').length,
      }
    : null;

  if (loading) {
    return (
      <div className="min-h-screen" style={{ backgroundColor: '#FAFAF9' }}>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#71717A' }} />
        </div>
      </div>
    );
  }

  if (error && !execution) {
    return (
      <div className="min-h-screen" style={{ backgroundColor: '#FAFAF9' }}>
        <div className="p-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm mb-6 hover:underline"
            style={{ color: '#71717A' }}
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!execution) {
    return null;
  }

  const mermaidChart = getMermaidChart();

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FAFAF9' }}>
      <header className="border-b py-6 px-6" style={{ borderColor: '#E4E4E7' }}>
        <div className="flex items-start justify-between">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm mb-4 hover:underline"
              style={{ color: '#71717A' }}
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Executions
            </Link>
            
            {/* Prominent workflow_id and tender_id */}
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase" style={{ color: '#71717A' }}>Workflow:</span>
                <span 
                  className="inline-flex items-center px-2 py-1 rounded text-sm font-mono font-bold"
                  style={{ backgroundColor: '#F4F4F5', color: '#09090B' }}
                >
                  {execution.workflow_id}
                </span>
                <CopyButton text={execution.workflow_id} />
              </div>
              
              {execution.tender_id && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase" style={{ color: '#71717A' }}>Tender:</span>
                  <a
                    href={`${TENDER_SERVER}/tenders/${execution.tender_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-2 py-1 rounded text-sm font-mono hover:underline"
                    style={{ backgroundColor: '#EFF6FF', color: '#2563EB' }}
                  >
                    {execution.tender_id.substring(execution.tender_id.length - 8)}
                  </a>
                  <CopyButton text={execution.tender_id} />
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-xl font-bold" style={{ color: '#09090B' }}>
                Execution Details
              </h1>
              <StatusBadge status={execution.status} />
            </div>
            <div className="flex items-center gap-4 text-sm" style={{ color: '#71717A' }}>
              <span className="flex items-center gap-1">
                <Clock className="w-4 h-4" />
                {formatDuration(execution.duration_ms)}
              </span>
              <span className="font-mono text-xs" title="Correlation ID">
                Correlation: {execution.correlation_id}
              </span>
              {execution.tender_id && (
                <a
                  href={`${TENDER_SERVER}/tenders/${execution.tender_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 hover:underline"
                  style={{ color: '#09090B' }}
                >
                  <ExternalLink className="w-4 h-4" />
                  View Tender
                </a>
              )}
            </div>
          </div>
          {execution.status === 'error' && ['tender-stage2-requirements', 'tender-stage3-evaluation'].includes(execution.workflow_id) && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded border hover:bg-zinc-100 disabled:opacity-50"
              style={{ color: '#09090B', borderColor: '#E4E4E7' }}
            >
              {retrying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
              Retry
            </button>
          )}
        </div>
      </header>

      <main className="p-6">
        {/* Stats Bar */}
        {stats && (
          <div 
            className="flex items-center gap-6 px-4 py-3 rounded mb-6 text-sm"
            style={{ backgroundColor: '#F4F4F5' }}
          >
            <span style={{ color: '#09090B' }}>
              <strong>{stats.total}</strong> nodes
            </span>
            <span className="text-green-700">
              <strong>{stats.passed}</strong> passed
            </span>
            <span className="text-red-700">
              <strong>{stats.failed}</strong> failed
            </span>
            {stats.running > 0 && (
              <span className="text-amber-700">
                <strong>{stats.running}</strong> running
              </span>
            )}
            <span style={{ color: '#71717A' }}>
              Total: <strong>{formatDuration(execution.duration_ms)}</strong>
            </span>
          </div>
        )}

        {execution.status === 'error' && execution.safe_error_code && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
            <div className="font-medium">Execution Failed</div>
            <div className="text-sm mt-1">
              Error code: <code>{execution.safe_error_code}</code>
            </div>
          </div>
        )}

        {/* Workflow Diagram */}
        {mermaidChart && (
          <div className="mb-6">
            <h2 className="text-sm font-medium uppercase tracking-wider mb-4" style={{ color: '#71717A' }}>
              Workflow Diagram
            </h2>
            <div
              className="border rounded p-4 overflow-auto"
              style={{ borderColor: '#E4E4E7', backgroundColor: '#FFFFFF' }}
            >
              <MermaidDiagram chart={mermaidChart} className="flex justify-center" />
            </div>
          </div>
        )}

        <div className="mb-4">
          <h2 className="text-sm font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
            Node Timeline
          </h2>
        </div>

        {execution.node_runs.length === 0 ? (
          <div className="flex items-center justify-center py-12 gap-3" style={{ color: '#71717A' }}>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Running...</span>
          </div>
        ) : (
          <div className="border rounded" style={{ borderColor: '#E4E4E7', backgroundColor: '#FFFFFF' }}>
            {execution.node_runs.map((nodeRun) => (
              <NodeRunRow key={`${nodeRun.stage}-${nodeRun.started_at}`} nodeRun={nodeRun} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
