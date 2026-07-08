import React, { useEffect, useState } from 'react';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

interface ReferenceResult {
  formKey?: string | null;
  plugin?: string | null;
  fieldPath?: string | null;
  recordType?: string | null;
  editorId?: string | null;
}

interface Group {
  formKey: string;
  recordType: string;
  editorId: string | null;
  results: ReferenceResult[];
}

function groupResults(results: ReferenceResult[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of results) {
    const key = r.formKey ?? '';
    if (!map.has(key)) {
      map.set(key, {
        formKey: key,
        recordType: r.recordType ?? '',
        editorId: r.editorId ?? null,
        results: [],
      });
    }
    map.get(key)!.results.push(r);
  }
  return Array.from(map.values());
}

function GroupRow({ group }: { group: Group }) {
  const [expanded, setExpanded] = useState(false);
  const label = `${group.recordType} / ${group.editorId ?? group.formKey}`;
  const count = group.results.length;

  function handleChevronClick(e: React.MouseEvent) {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }

  function handleRowClick() {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: group.formKey });
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD_BESIDE, formKey: group.formKey });
  }

  return (
    <div>
      <div
        style={{ cursor: 'pointer', userSelect: 'none', padding: '2px 0' }}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
      >
        <span data-testid="expand-toggle" onClick={handleChevronClick}>{expanded ? '▼' : '▶'}</span>
        {' '}{label}
        {count > 1 && <span style={{ marginLeft: 6, opacity: 0.6 }}>({count} plugins)</span>}
      </div>
      {expanded && group.results.map((r, i) => (
        <div
          key={i}
          data-testid="ref-child-row"
          style={{ paddingLeft: 16, display: 'flex', gap: 8, opacity: 0.8 }}
        >
          <span>{r.plugin ?? ''}</span>
          <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>{r.fieldPath ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

export function ReferencedByApp() {
  const win = window as Window & typeof globalThis & {
    mEditFormKey: string;
    mEditBackendPort: number;
  };
  const formKey = win.mEditFormKey ?? '';
  const port = win.mEditBackendPort;

  type State =
    | { kind: 'loading' }
    | { kind: 'loaded'; groups: Group[] }
    | { kind: 'error'; message: string };

  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`http://localhost:${port}/records/${encodeURIComponent(formKey)}/references`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<ReferenceResult[]>;
      })
      .then((results) => {
        if (!cancelled) setState({ kind: 'loaded', groups: groupResults(results) });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => { cancelled = true; };
  }, [formKey, port]);

  if (state.kind === 'loading') return <div style={{ opacity: 0.6 }}>Loading…</div>;
  if (state.kind === 'error') return <div style={{ opacity: 0.6 }}>{state.message}</div>;
  if (state.groups.length === 0) return <div style={{ opacity: 0.6 }}>No references found</div>;

  return (
    <div>
      {state.groups.map((g) => (
        <GroupRow key={g.formKey} group={g} />
      ))}
    </div>
  );
}
