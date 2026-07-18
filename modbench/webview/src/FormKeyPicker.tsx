import React, { useEffect, useRef, useState } from 'react';
import type { FormKeySearchResult, RecordSessionClient } from './RecordSessionClient';

interface Props {
  client: RecordSessionClient;
  validTypes: string[];
  onSelect: (formKey: string) => void;
  onClose: () => void;
}

export function FormKeyPicker({ client, validTypes, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FormKeySearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
  const fg = 'var(--vscode-editor-foreground, #ccc)';
  const borderColor = 'var(--vscode-editorGroup-border, #444)';
  const bg = 'var(--vscode-editor-background, #1e1e1e)';

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) return;
    const controller = new AbortController();
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const items = await client.searchRecords(query, validTypes, controller.signal);
          if (controller.signal.aborted) return;
          setResults(items);
          setSelectedIdx(0);
        } catch { /* ignore network + abort errors */ }
      })();
    }, 200);
    return () => { controller.abort(); if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, client, validTypes]);

  useEffect(() => {
    const el = dropdownRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { setSelectedIdx(i => Math.min(i + 1, results.length - 1)); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { setSelectedIdx(i => Math.max(i - 1, 0)); e.preventDefault(); return; }
    if (e.key === 'Enter' && results[selectedIdx]) { onSelect(results[selectedIdx].formKey); }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <input
        ref={inputRef}
        value={query}
        onChange={e => { setQuery(e.target.value); if (!e.target.value.trim()) setResults([]); }}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(onClose, 150)}
        placeholder="Search EditorID…"
        style={{
          fontFamily: mono,
          fontSize: '12px',
          background: 'var(--vscode-input-background, #3c3c3c)',
          color: fg,
          border: `1px solid ${borderColor}`,
          padding: '2px 6px',
          width: '220px',
        }}
      />
      {results.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 999,
            background: bg,
            border: `1px solid ${borderColor}`,
            minWidth: '220px',
            maxHeight: '180px',
            overflowY: 'auto',
          }}
        >
          {results.map((r, i) => (
            <div
              key={r.formKey}
              onMouseDown={() => onSelect(r.formKey)}
              style={{
                padding: '3px 8px',
                cursor: 'pointer',
                fontFamily: mono,
                fontSize: '11px',
                background: i === selectedIdx ? 'var(--vscode-list-hoverBackground, #2a2d2e)' : 'transparent',
                color: fg,
              }}
            >
              {r.editorId ? `${r.editorId} [${r.formKey}]` : r.formKey}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
