'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Play, X, ExternalLink } from 'lucide-react';

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  nodeCount: number;
  edgeCount: number;
  error?: string;
}

const TENDER_SERVER = 'http://100.116.26.90:3844';

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState<string | null>(null);

  const fetchWorkflows = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/flow/workflows');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorkflows(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const handleRefresh = () => {
    fetchWorkflows(true);
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
              Workflow Definitions
            </p>
          </div>
          <nav className="flex items-center gap-4">
            <Link 
              href="/" 
              className="text-sm font-medium px-3 py-1.5 rounded hover:bg-zinc-100"
              style={{ color: '#71717A' }}
            >
              Executions
            </Link>
            <Link 
              href="/workflows" 
              className="text-sm font-medium px-3 py-1.5 rounded bg-zinc-100"
              style={{ color: '#09090B' }}
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
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-medium" style={{ color: '#09090B' }}>
            Available Workflows
          </h2>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded border hover:bg-zinc-100 disabled:opacity-50"
            style={{ color: '#09090B', borderColor: '#E4E4E7' }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {loading && (
          <div className="text-center py-12" style={{ color: '#71717A' }}>
            Loading workflows…
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {!loading && !error && workflows.length === 0 && (
          <div className="text-center py-12">
            <p className="text-lg font-medium" style={{ color: '#09090B' }}>
              No workflows found
            </p>
            <p className="text-sm mt-1" style={{ color: '#71717A' }}>
              Add workflow definitions to the workflows/ directory.
            </p>
          </div>
        )}

        {!loading && workflows.length > 0 && (
          <div className="grid gap-4">
            {workflows.map((wf) => (
              <div
                key={wf.id}
                className="border rounded-lg p-4 bg-white"
                style={{ borderColor: '#E4E4E7' }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span 
                        className="inline-flex items-center px-2 py-1 rounded text-sm font-mono font-bold"
                        style={{ backgroundColor: '#F4F4F5', color: '#09090B' }}
                      >
                        {wf.id}
                      </span>
                      {wf.version && (
                        <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: '#EFF6FF', color: '#2563EB' }}>
                          v{wf.version}
                        </span>
                      )}
                    </div>
                    <h3 className="text-lg font-medium mb-1" style={{ color: '#09090B' }}>
                      {wf.name}
                    </h3>
                    {wf.description && (
                      <p className="text-sm mb-3" style={{ color: '#71717A' }}>
                        {wf.description}
                      </p>
                    )}
                    <div className="flex items-center gap-4 text-sm" style={{ color: '#71717A' }}>
                      <span><strong>{wf.nodeCount}</strong> nodes</span>
                      <span><strong>{wf.edgeCount}</strong> edges</span>
                    </div>
                    {wf.error && (
                      <div className="mt-2 text-sm text-red-600">
                        ⚠️ {wf.error}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/?workflow=${wf.id}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded border hover:bg-zinc-100"
                      style={{ color: '#09090B', borderColor: '#E4E4E7' }}
                    >
                      <ExternalLink className="w-4 h-4" />
                      View Executions
                    </Link>
                    <button
                      onClick={() => setShowModal(wf.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded bg-zinc-900 text-white hover:bg-zinc-800"
                    >
                      <Play className="w-4 h-4" />
                      Run Test
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium" style={{ color: '#09090B' }}>
                Run Workflow
              </h3>
              <button
                onClick={() => setShowModal(null)}
                className="p-1 rounded hover:bg-zinc-100"
              >
                <X className="w-5 h-5" style={{ color: '#71717A' }} />
              </button>
            </div>
            <p className="text-sm mb-4" style={{ color: '#71717A' }}>
              To trigger the <strong>{showModal}</strong> pipeline, use the file upload flow in Tenderly.
              This will create a new tender which triggers the workflow execution.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowModal(null)}
                className="px-4 py-2 text-sm font-medium rounded border hover:bg-zinc-100"
                style={{ borderColor: '#E4E4E7', color: '#71717A' }}
              >
                Close
              </button>
              <a
                href={TENDER_SERVER}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-4 py-2 text-sm font-medium rounded bg-zinc-900 text-white hover:bg-zinc-800"
              >
                Open Tenderly
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
