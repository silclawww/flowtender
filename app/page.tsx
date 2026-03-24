'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';

interface Execution {
  id: string;
  workflow_id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  tender_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
}

const TENDER_SERVER = 'http://100.116.26.90:3844';

function StatusBadge({ status }: { status: Execution['status'] }) {
  const styles: Record<string, string> = {
    running: 'bg-amber-100 text-amber-800',
    done: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
    pending: 'bg-zinc-100 text-zinc-700',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function truncateId(id: string | null, length = 8): string {
  if (!id) return '—';
  if (id.length <= length) return id;
  return id.substring(id.length - length);
}

export default function Home() {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  
  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');

  const fetchExecutions = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/flow/executions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExecutions(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  useEffect(() => {
    const hasRunning = executions.some((e) => e.status === 'running');
    if (!hasRunning) return;

    const interval = setInterval(() => fetchExecutions(), 5000);
    return () => clearInterval(interval);
  }, [executions, fetchExecutions]);

  // Get unique workflow IDs for filter dropdown
  const workflowIds = useMemo(() => {
    const ids = new Set(executions.map(e => e.workflow_id));
    return Array.from(ids).sort();
  }, [executions]);

  // Filtered executions
  const filteredExecutions = useMemo(() => {
    return executions.filter(exec => {
      if (statusFilter !== 'all' && exec.status !== statusFilter) return false;
      if (workflowFilter !== 'all' && exec.workflow_id !== workflowFilter) return false;
      return true;
    });
  }, [executions, statusFilter, workflowFilter]);

  const handleRefresh = () => {
    fetchExecutions(true);
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FAFAF9' }}>
      <header className="border-b py-6 px-6" style={{ borderColor: '#E4E4E7' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: '#09090B' }}>
              flowtender
            </h1>
            <p className="text-sm mt-1" style={{ color: '#71717A' }}>
              Workflow Execution Inspector
            </p>
          </div>
          <nav className="flex items-center gap-4">
            <Link 
              href="/" 
              className="text-sm font-medium px-3 py-1.5 rounded bg-zinc-100"
              style={{ color: '#09090B' }}
            >
              Executions
            </Link>
            <Link 
              href="/workflows" 
              className="text-sm font-medium px-3 py-1.5 rounded hover:bg-zinc-100"
              style={{ color: '#71717A' }}
            >
              Workflows
            </Link>
            <a 
              href={TENDER_SERVER}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium px-3 py-1.5 rounded hover:bg-zinc-100"
              style={{ color: '#71717A' }}
            >
              Tenderly ↗
            </a>
          </nav>
        </div>
      </header>

      <main className="p-6">
        {/* Filter Row */}
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" style={{ color: '#71717A' }}>Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded bg-white"
              style={{ borderColor: '#E4E4E7', color: '#09090B' }}
            >
              <option value="all">All</option>
              <option value="done">Done</option>
              <option value="running">Running</option>
              <option value="error">Error</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" style={{ color: '#71717A' }}>Workflow:</label>
            <select
              value={workflowFilter}
              onChange={(e) => setWorkflowFilter(e.target.value)}
              className="px-3 py-1.5 text-sm border rounded bg-white"
              style={{ borderColor: '#E4E4E7', color: '#09090B' }}
            >
              <option value="all">All</option>
              {workflowIds.map(id => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="ml-auto inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded border hover:bg-zinc-100 disabled:opacity-50"
            style={{ color: '#09090B', borderColor: '#E4E4E7' }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {loading && (
          <div className="text-center py-12" style={{ color: '#71717A' }}>
            Loading executions…
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {!loading && !error && filteredExecutions.length === 0 && (
          <div className="text-center py-12">
            <p className="text-lg font-medium" style={{ color: '#09090B' }}>
              No executions found
            </p>
            <p className="text-sm mt-1" style={{ color: '#71717A' }}>
              {executions.length > 0 ? 'Try adjusting your filters.' : 'No workflows have been executed yet.'}
            </p>
          </div>
        )}

        {!loading && filteredExecutions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b" style={{ borderColor: '#E4E4E7' }}>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Workflow
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Tender
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Duration
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Started
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: '#71717A' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredExecutions.map((exec) => (
                  <tr
                    key={exec.id}
                    className="border-b hover:bg-zinc-50"
                    style={{ borderColor: '#E4E4E7' }}
                  >
                    <td className="py-3 px-4">
                      <span 
                        className="inline-flex items-center px-2 py-1 rounded text-sm font-mono font-bold"
                        style={{ backgroundColor: '#F4F4F5', color: '#09090B' }}
                      >
                        {exec.workflow_id}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={exec.status} />
                    </td>
                    <td className="py-3 px-4">
                      {exec.tender_id ? (
                        <a
                          href={`${TENDER_SERVER}/tenders/${exec.tender_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono hover:underline"
                          style={{ backgroundColor: '#EFF6FF', color: '#2563EB' }}
                        >
                          …{truncateId(exec.tender_id)}
                        </a>
                      ) : (
                        <span className="text-sm" style={{ color: '#A1A1AA' }}>—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm" style={{ color: '#71717A' }}>
                      {formatDuration(exec.duration_ms)}
                    </td>
                    <td className="py-3 px-4 text-sm" style={{ color: '#71717A' }}>
                      {formatDate(exec.started_at)}
                    </td>
                    <td className="py-3 px-4">
                      <Link
                        href={`/execution/${exec.id}`}
                        className="inline-flex items-center px-4 py-2 text-sm font-medium rounded bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
