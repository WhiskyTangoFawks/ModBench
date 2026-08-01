import React, { useEffect, useState } from 'react';
import { mono, fg } from './gridStyles';
import type { RecordSessionClient } from './RecordSessionClient';

export interface ConditionFunctionPickerProps {
  value: string;
  client: RecordSessionClient;
  onCommit: (fn: string) => void;
}

// Searchable function picker (#152) — the ~479 shared condition-function slots (filtered server-
// side to the loaded game/category via GET /condition-functions) are too many for a flat <select>,
// so this is a rendered search-box: button shows the current value, click opens a filter-as-you-
// type list. The catalog is fetched once per picker session (game-scoped, small), then filtered
// client-side — unlike the FormKey picker (#210, now a native QuickPick in the extension host),
// this one is intentionally still a rendered dropdown: the catalog is small/game-scoped, not a
// per-keystroke server search over a much larger per-record-type result set. Migrating this one
// to a native surface too is out of scope for #210.
export function ConditionFunctionPicker({ value, client, onCommit }: Readonly<ConditionFunctionPickerProps>) {
  const [picking, setPicking] = useState(false);
  const [all, setAll] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!picking) return;
    let cancelled = false;
    void client.conditionFunctions().then(names => { if (!cancelled) setAll(names); });
    return () => { cancelled = true; };
  }, [picking, client]);

  const inputStyle: React.CSSProperties = {
    fontFamily: mono,
    fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)',
    color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '2px 6px',
    width: '220px',
  };

  if (!picking) {
    return (
      <button
        onClick={() => { setQuery(''); setPicking(true); }}
        style={{
          background: 'var(--vscode-input-background, #3c3c3c)',
          border: '1px solid var(--vscode-input-border, #555)',
          color: value ? 'var(--vscode-textLink-foreground, #3794ff)' : fg,
          cursor: 'pointer',
          fontFamily: mono,
          fontSize: '12px',
          padding: '1px 4px',
        }}
      >
        {value || <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>
    );
  }

  const results = query.trim()
    ? all.filter(f => f.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50)
    : [];

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setPicking(false); }}
        onBlur={() => setTimeout(() => setPicking(false), 150)}
        placeholder="Search function…"
        aria-label="Search condition function"
        style={inputStyle}
      />
      {results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 999,
            background: 'var(--vscode-editor-background, #1e1e1e)',
            border: '1px solid var(--vscode-editorGroup-border, #444)',
            minWidth: '220px',
            maxHeight: '180px',
            overflowY: 'auto',
          }}
        >
          {results.map(f => (
            <div
              key={f}
              onMouseDown={() => { onCommit(f); setPicking(false); }}
              style={{ padding: '3px 8px', cursor: 'pointer', fontFamily: mono, fontSize: '11px', color: fg }}
            >
              {f}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
