'use client';

import { useEffect, useRef, useState } from 'react';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    setError(null);

    // Dynamic import to avoid SSR issues
    import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        flowchart: { curve: 'basis' },
      });
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      m.default.render(id, chart).then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg;
      }).catch((err) => {
        setError(String(err));
      });
    }).catch((err) => {
      setError(String(err));
    });
  }, [chart]);

  if (error) {
    return (
      <div className={className}>
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          Diagramm konnte nicht geladen werden: {error}
        </div>
      </div>
    );
  }

  return <div ref={ref} className={className} />;
}
