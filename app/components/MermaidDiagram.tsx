'use client';

import { useEffect, useState } from 'react';
import { svgToImageSource } from '@/lib/safe-svg';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setFailed(false);

    // Dynamic import to avoid SSR issues
    import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        flowchart: { curve: 'basis' },
      });
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      m.default.render(id, chart).then(({ svg }) => {
        if (!cancelled) setSource(svgToImageSource(svg));
      }).catch(() => {
        if (!cancelled) setFailed(true);
      });
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => { cancelled = true; };
  }, [chart]);

  if (failed) {
    return (
      <div className={className}>
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
          Diagramm konnte nicht geladen werden.
        </div>
      </div>
    );
  }

  if (!source) return <div className={className} aria-busy="true" />;

  return (
    <div className={className}>
      <img src={source} alt="Workflow-Diagramm" />
    </div>
  );
}
