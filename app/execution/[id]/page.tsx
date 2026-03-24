'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
} from 'lucide-react';

interface NodeRun {
  id: string;
  node_id: string;
  node_type: string;
  node_name: string;
  status: string;
  input: object[];
  output: object[];
  error?: string;
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
  error?: string;
  node_runs: NodeRun[];
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

function NodeRunRow({ nodeRun }: { nodeRun: NodeRun }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="border-b"
      style={{ borderColor: '#E4E4E7' }}
    >
      <div
        className="flex items-center justify-between py-3 px-4 hover:bg-zinc-50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <NodeStatusIcon status={nodeRun.status} />
          <div>
            <div className="text-sm font-medium" style={{ color: '#09090B' }}>
              {nodeRun.node_name}
            </div>
            <div className="text-xs" style={{ color: '#71717A' }}>
              {nodeRun.node_type}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <StatusBadge status={nodeRun.status} />
          <span className="text-sm" style={{ color: '#71717A' }}>
            {formatDuration(nodeRun.duration_ms)}
          </span>
          {expanded ? (
            <ChevronUp className="w-4 h-4" style={{ color: '#71717A' }} />
          ) : (
            <ChevronDown className="w-4 h-4" style={{ color: '#71717A' }} />
          )}
        </div>
      </div>

      {nodeRun.status === 'error' && nodeRun.error && (
        <div className="px-4 pb-3">
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            {nodeRun.error}
          </div>
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-medium mb-2" style={{ color: '#71717A' }}>
              Input
            </div>
            <pre className="bg-zinc-50 p-3 rounded text-xs font-mono overflow-auto max-h-64" style={{ color: '#09090B' }}>
              {JSON.stringify(nodeRun.input, null, 2)}
            </pre>
          </div>
          <div>
            <div className="text-xs font-medium mb-2" style={{ color: '#71717A' }}>
              Output
            </div>
            <pre className="bg-zinc-50 p-3 rounded text-xs font-mono overflow-auto max-h-64" style={{ color: '#09090B' }}>
              {JSON.stringify(nodeRun.output, null, 2)}
            </pre>
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
      if (data.error) throw new Error(data.error);
      router.push(`/execution/${data.id}`);
    } catch (err) {
      setError(String(err));
      setRetrying(false);
    }
  };

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
            Zurück
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
              Zurück
            </Link>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-xl font-bold font-mono" style={{ color: '#09090B' }}>
                {execution.workflow_id}
              </h1>
              <StatusBadge status={execution.status} />
            </div>
            <div className="flex items-center gap-4 text-sm" style={{ color: '#71717A' }}>
              <span className="flex items-center gap-1">
                <Clock className="w-4 h-4" />
                {formatDuration(execution.duration_ms)}
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
                  Ausschreibung ansehen
                </a>
              )}
            </div>
          </div>
          {execution.status === 'error' && (
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
              Erneut versuchen
            </button>
          )}
        </div>
      </header>

      <main className="p-6">
        {execution.status === 'error' && execution.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
            <div className="font-medium">Ausführung fehlgeschlagen</div>
            <div className="text-sm mt-1">{execution.error}</div>
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
            <span>Wird ausgeführt...</span>
          </div>
        ) : (
          <div className="border rounded" style={{ borderColor: '#E4E4E7', backgroundColor: '#FFFFFF' }}>
            {execution.node_runs.map((nodeRun) => (
              <NodeRunRow key={nodeRun.id} nodeRun={nodeRun} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
