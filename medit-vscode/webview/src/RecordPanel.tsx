import React, { useCallback, useEffect, useState } from 'react';
import { ArrayRowGroup } from './ArrayRowGroup';
import { FormKeyPicker } from './FormKeyPicker';
import { StructRowGroup } from './StructRowGroup';
import { buildColumns } from './recordUtils';
import type { Column } from './recordUtils';
import type { CompareOverride, CompareResult, ConflictAll, ConflictThis, FieldDiff, FieldMetadata, PendingChange, RecordDetail } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
  mEditBackendPort: number;
};

const mono = 'var(--vscode-editor-font-family, "Consolas", monospace)';
const fg = 'var(--vscode-editor-foreground, #ccc)';
const borderColor = 'var(--vscode-editorGroup-border, #444)';

const baseCell: React.CSSProperties = {
  border: `1px solid ${borderColor}`,
  padding: '3px 8px',
  verticalAlign: 'top',
  fontFamily: mono,
  fontSize: '12px',
  color: fg,
  maxWidth: '260px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override: 'rgba(76,175,80,0.08)',
  Conflict: 'rgba(255,152,0,0.08)',
};

const COL_BG: Partial<Record<ConflictThis, string>> = {
  IdenticalToMaster: 'rgba(150,150,150,0.18)',
  Override:          'rgba(76,175,80,0.18)',
  ConflictWins:      'rgba(255,152,0,0.18)',
  ConflictLoses:     'rgba(244,67,54,0.18)',
};

const getRowBg = (c: ConflictAll): string | undefined => ROW_BG[c];
const getColBg = (c: ConflictThis | undefined): string | undefined => c !== undefined ? COL_BG[c] : undefined;

// ── ScalarCell ────────────────────────────────────────────────────────────────

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  editMode: boolean;
  onCommit: (v: unknown) => void;
}

export function ScalarCell({ value, meta, editMode, onCommit }: ScalarCellProps) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));

  useEffect(() => { setDraft(value == null ? '' : String(value)); }, [value]);

  if (!editMode) {
    return value == null
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{String(value)}</span>;
  }

  const inputBase: React.CSSProperties = {
    fontFamily: mono,
    fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)',
    color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px',
    width: '100%',
    boxSizing: 'border-box',
  };

  if (meta.type === 'bool') {
    return (
      <input
        type="checkbox"
        checked={draft === 'true'}
        onChange={e => { setDraft(String(e.target.checked)); onCommit(e.target.checked); }}
      />
    );
  }

  if (meta.type === 'enum' && meta.enumValues.length > 0) {
    return (
      <select value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => onCommit(draft)} style={inputBase}>
        {meta.enumValues.map(ev => <option key={ev}>{ev}</option>)}
      </select>
    );
  }

  function coerce(): unknown {
    if (meta.type === 'int') { const n = parseInt(draft, 10); return isNaN(n) ? value : n; }
    if (meta.type === 'float') { const n = parseFloat(draft); return isNaN(n) ? value : n; }
    return draft;
  }

  return (
    <input
      type={meta.type === 'int' || meta.type === 'float' ? 'number' : 'text'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onCommit(coerce())}
      onKeyDown={e => { if (e.key === 'Enter') { onCommit(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputBase}
    />
  );
}

// ── FormKeyCell ───────────────────────────────────────────────────────────────

interface FormKeyCellProps {
  value: unknown;
  meta: FieldMetadata;
  editMode: boolean;
  port: number;
  onOpen: (fk: string) => void;
  onCommit: (fk: string) => void;
}

export function FormKeyCell({ value, meta, editMode, port, onOpen, onCommit }: FormKeyCellProps) {
  const [picking, setPicking] = useState(false);

  if (editMode) {
    if (picking) {
      return (
        <FormKeyPicker
          port={port}
          validTypes={meta.validFormKeyTypes}
          onSelect={fk => { setPicking(false); onCommit(fk); }}
          onClose={() => setPicking(false)}
        />
      );
    }
    return (
      <button
        onClick={() => setPicking(true)}
        style={{
          background: 'var(--vscode-input-background, #3c3c3c)',
          border: '1px solid var(--vscode-input-border, #555)',
          color: typeof value === 'string' && value ? 'var(--vscode-textLink-foreground, #3794ff)' : fg,
          cursor: 'pointer',
          fontFamily: mono,
          fontSize: '12px',
          padding: '1px 4px',
          textAlign: 'left',
          width: '100%',
        }}
      >
        {typeof value === 'string' && value
          ? value
          : <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>
    );
  }

  if (typeof value !== 'string' || !value) return <span style={{ opacity: 0.35 }}>—</span>;
  return (
    <button
      onClick={() => onOpen(value)}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--vscode-textLink-foreground, #3794ff)',
        cursor: 'pointer',
        fontFamily: mono,
        fontSize: '12px',
        padding: 0,
        textDecoration: 'underline',
        textAlign: 'left',
      }}
    >
      {value}
    </button>
  );
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

function renderCell(
  value: unknown,
  meta: FieldMetadata,
  editMode: boolean,
  port: number,
  onOpen: (fk: string) => void,
  onCommit: (v: unknown) => void,
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} editMode={editMode} port={port}
        onOpen={onOpen} onCommit={fk => onCommit(fk)}
      />
    );
  }
  if (meta.type === 'array') {
    return (
      <ArrayRowGroup
        value={value as unknown[]} meta={meta} editMode={editMode} port={port}
        onOpen={onOpen} onCommit={v => onCommit(v)} storageKey={`array:${meta.name}`}
      />
    );
  }
  if (meta.type === 'struct') {
    return (
      <StructRowGroup
        value={value as Record<string, unknown>} meta={meta} editMode={editMode} port={port}
        onOpen={onOpen} onCommit={v => onCommit(v)} storageKey={`struct:${meta.name}`}
      />
    );
  }
  return <ScalarCell value={value} meta={meta} editMode={editMode} onCommit={onCommit} />;
}

// ── PluginHeader ──────────────────────────────────────────────────────────────

interface PluginHeaderProps {
  override: RecordDetail;
  isImmutable: boolean;
  editMode: boolean;
  saving: boolean;
  showCopyPicker: boolean;
  mutableTargets: PluginInfo[];
  onSave: () => void;
  onOpenCopyPicker: () => void;
  onCloseCopyPicker: () => void;
  onCopyTo: (target: string) => void;
}

function PluginHeader({
  override: o, isImmutable, editMode, saving,
  showCopyPicker, mutableTargets,
  onSave, onOpenCopyPicker, onCloseCopyPicker, onCopyTo,
}: PluginHeaderProps) {
  const btnStyle: React.CSSProperties = {
    fontSize: '10px',
    padding: '1px 5px',
    marginLeft: 4,
    cursor: 'pointer',
    background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: 'var(--vscode-button-secondaryForeground, #ccc)',
    border: '1px solid var(--vscode-button-secondaryHoverBackground, #45494e)',
    borderRadius: 2,
  };
  return (
    <div>
      <div>{o.plugin}</div>
      <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
        [{o.loadOrderIndex}]{o.isWinner ? ' ✓ winner' : ''}
      </div>
      {isImmutable && (
        <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>
          (read-only)
        </div>
      )}
      {editMode && !isImmutable && (
        <div style={{ marginTop: 3, position: 'relative' }}>
          <button style={btnStyle} onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button style={btnStyle} onClick={onOpenCopyPicker}>
            Copy as Override…
          </button>
          {showCopyPicker && (
            // onMouseDown on items fires before onBlur, so selection works correctly
            <div
              onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onCloseCopyPicker(); }}
              tabIndex={-1}
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 10,
                background: 'var(--vscode-dropdown-background, #3c3c3c)',
                border: '1px solid var(--vscode-dropdown-border, #555)',
                borderRadius: 2,
                minWidth: 180,
                maxHeight: 200,
                overflowY: 'auto',
                outline: 'none',
              }}
            >
              {mutableTargets.length === 0 && (
                <div style={{ padding: '4px 8px', opacity: 0.5, fontSize: '11px' }}>No mutable plugins</div>
              )}
              {mutableTargets.map(p => (
                <div
                  key={p.name}
                  onMouseDown={() => { onCopyTo(p.name); onCloseCopyPicker(); }}
                  style={{
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: 'var(--vscode-dropdown-foreground, #ccc)',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
                >
                  {p.name}
                  <span style={{ opacity: 0.55, marginLeft: 6 }}>[{p.loadOrderIndex}]</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DiffRow ───────────────────────────────────────────────────────────────────

interface DiffRowProps {
  diff: FieldDiff;
  conflictAll: ConflictAll;
  columns: Column[];
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  editMode: boolean;
  port: number;
  pendingChangeMap: Record<string, PendingChange>;
  onOpen: (fk: string) => void;
  onEdit: (plugin: string, fieldName: string, value: unknown) => void;
  onRevert: (changeId: string) => void;
}

function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, editMode, port,
  pendingChangeMap, onOpen, onEdit, onRevert,
}: DiffRowProps) {
  const meta = fieldMetaMap[diff.fieldName];
  if (!meta) return null;

  return (
    <tr style={{ backgroundColor: getRowBg(conflictAll) }}>
      <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text' }}>{diff.fieldName}</td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { override: o } = col;
          const bg = getColBg(o.conflictThis);
          return (
            <td key={`disk:${o.plugin}`} style={{ ...baseCell, backgroundColor: bg, userSelect: 'text' }}>
              {renderCell(diff.values[o.plugin], meta, editMode, port, onOpen,
                v => onEdit(o.plugin, diff.fieldName, v))}
            </td>
          );
        }

        // pending companion column
        const override = overrideMap[col.plugin];
        const pendingValue = override?.pendingFields?.[diff.fieldName];
        const change = pendingChangeMap[`${col.plugin}:${diff.fieldName}`];
        const hasPending = pendingValue !== undefined;
        return (
          <td
            key={`pending:${col.plugin}`}
            style={{
              ...baseCell,
              backgroundColor: hasPending ? 'rgba(255,200,50,0.10)' : undefined,
              fontStyle: 'italic',
              opacity: hasPending ? 1 : 0.3,
            }}
          >
            {hasPending && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span>{String(pendingValue)}</span>
                {change && (
                  <button
                    onClick={() => onRevert(change.id)}
                    title="Revert this change"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--vscode-errorForeground, #f88)',
                      fontSize: '11px',
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >↩</button>
                )}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ── RecordPanel ───────────────────────────────────────────────────────────────

interface PluginInfo { name: string; isImmutable: boolean; loadOrderIndex: number }

export function RecordPanel() {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [allChanges, setAllChanges] = useState<PendingChange[]>([]);
  const [allPlugins, setAllPlugins] = useState<PluginInfo[]>([]);
  const [immutableSet, setImmutableSet] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [savingPlugin, setSavingPlugin] = useState<string | null>(null);
  const [copyPickerPlugin, setCopyPickerPlugin] = useState<string | null>(null);

  const port = mEditWindow.mEditBackendPort;

  const refresh = useCallback(async (fk: string) => {
    if (!fk || !port) return;
    try {
      const [cmpRes, chgRes, pluginsRes] = await Promise.all([
        fetch(`http://localhost:${port}/records/${encodeURIComponent(fk)}/compare`),
        fetch(`http://localhost:${port}/changes?formKey=${encodeURIComponent(fk)}`),
        fetch(`http://localhost:${port}/plugins`),
      ]);
      if (!cmpRes.ok) throw new Error(`HTTP ${cmpRes.status}`);
      setResult(await cmpRes.json() as CompareResult);
      if (chgRes.ok) setAllChanges(await chgRes.json() as PendingChange[]);
      if (pluginsRes.ok) {
        const plugins = await pluginsRes.json() as PluginInfo[];
        setAllPlugins(plugins);
        setImmutableSet(new Set(plugins.filter(p => p.isImmutable).map(p => p.name)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [port]);

  // Listen for loadRecord messages from extension (panel reuse)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type?: string; formKey?: string };
      if (msg.type === EXTENSION_TO_WEBVIEW.LOAD_RECORD && msg.formKey) {
        setFormKey(msg.formKey);
        setResult(null);
        setAllChanges([]);
        setError(null);
        setActionError(null);
        setEditMode(false);
        setCopyPickerPlugin(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!formKey || !port) return;
    setResult(null);
    setAllChanges([]);
    setError(null);
    setActionError(null);
    refresh(formKey);
  }, [formKey, port, refresh]);

  async function handleEdit(plugin: string, fieldName: string, value: unknown) {
    setActionError(null);
    const resp = await fetch(`http://localhost:${port}/records/${encodeURIComponent(formKey)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin, fields: { [fieldName]: value }, source: 'user' }),
    });
    if (!resp.ok) {
      setActionError(resp.status === 409 ? 'Plugin is read-only' : `Error: ${resp.statusText}`);
      return;
    }
    await refresh(formKey);
  }

  async function handleRevert(changeId: string) {
    setActionError(null);
    const resp = await fetch(`http://localhost:${port}/changes/${changeId}`, { method: 'DELETE' });
    if (!resp.ok) {
      setActionError(`Revert failed: ${resp.statusText}`);
      return;
    }
    await refresh(formKey);
  }

  async function handleSave(plugin: string) {
    setActionError(null);
    setSavingPlugin(plugin);
    try {
      const resp = await fetch(`http://localhost:${port}/plugins/${encodeURIComponent(plugin)}/save`, { method: 'POST' });
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Save failed: ${resp.statusText}`);
        return;
      }
      await refresh(formKey);
    } finally {
      setSavingPlugin(null);
    }
  }

  async function handleCopyTo(targetPlugin: string) {
    setActionError(null);
    try {
      const resp = await fetch(
        `http://localhost:${port}/records/${encodeURIComponent(formKey)}/copy-to/${encodeURIComponent(targetPlugin)}`,
        { method: 'POST' }
      );
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Copy failed: ${resp.statusText}`);
        return;
      }
      await refresh(formKey);
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  function handleOpen(fk: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: fk });
  }

  const containerStyle: React.CSSProperties = {
    padding: '12px',
    fontFamily: mono,
    fontSize: '12px',
    color: fg,
  };

  if (!formKey) return <div style={containerStyle}>No record selected.</div>;
  if (error) return <div style={{ ...containerStyle, color: 'var(--vscode-errorForeground, #f44)' }}>Error: {error}</div>;
  if (!result) return <div style={containerStyle}>Loading…</div>;

  const { overrides, diffs, conflictAll } = result;

  const fieldMetaMap: Record<string, FieldMetadata> = {};
  for (const fv of overrides[0]?.fields ?? []) {
    fieldMetaMap[fv.metadata.name] = fv.metadata;
  }

  const overrideMap: Record<string, CompareOverride> = {};
  for (const o of overrides) overrideMap[o.plugin] = o;

  const columns = buildColumns(overrides, immutableSet);

  const pendingChangeMap: Record<string, PendingChange> = {};
  for (const c of allChanges) {
    pendingChangeMap[`${c.plugin}:${c.fieldPath}`] = c;
  }

  const winner = overrides.find(o => o.isWinner);
  const displayId = (winner ?? overrides[0])?.editorId;
  const title = displayId ? `${displayId} [${formKey}]` : formKey;

  const editToggleStyle: React.CSSProperties = {
    fontSize: '11px',
    padding: '2px 8px',
    marginLeft: 10,
    cursor: 'pointer',
    background: editMode
      ? 'var(--vscode-button-background, #0e639c)'
      : 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: editMode
      ? 'var(--vscode-button-foreground, #fff)'
      : 'var(--vscode-button-secondaryForeground, #ccc)',
    border: 'none',
    borderRadius: 2,
  };

  return (
    <div style={containerStyle}>
      <div style={{ marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
        <button style={editToggleStyle} onClick={() => setEditMode(m => !m)}>
          {editMode ? 'View' : 'Edit'}
        </button>
      </div>
      {actionError && (
        <div style={{ marginBottom: 8, fontSize: '11px', color: 'var(--vscode-errorForeground, #f88)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-errorBorder, #f88)', borderRadius: 2 }}>
          {actionError}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...baseCell, fontWeight: 600, textAlign: 'left', minWidth: '160px' }}>Field</th>
              {columns.map(col => {
                if (col.kind === 'disk') {
                  return (
                    <th key={`disk:${col.override.plugin}`} style={{ ...baseCell, fontWeight: 600, textAlign: 'left', minWidth: '200px', backgroundColor: getColBg(col.override.conflictThis) }}>
                      <PluginHeader
                        override={col.override}
                        isImmutable={immutableSet.has(col.override.plugin)}
                        editMode={editMode}
                        saving={savingPlugin === col.override.plugin}
                        showCopyPicker={copyPickerPlugin === col.override.plugin}
                        mutableTargets={allPlugins.filter(p => !p.isImmutable)}
                        onSave={() => handleSave(col.override.plugin)}
                        onOpenCopyPicker={() => setCopyPickerPlugin(col.override.plugin)}
                        onCloseCopyPicker={() => setCopyPickerPlugin(null)}
                        onCopyTo={handleCopyTo}
                      />
                    </th>
                  );
                }
                return (
                  <th key={`pending:${col.plugin}`} style={{ ...baseCell, fontWeight: 400, textAlign: 'left', minWidth: '160px', fontStyle: 'italic', opacity: 0.7 }}>
                    <div>Pending</div>
                    <div style={{ fontSize: '11px', opacity: 0.6 }}>{col.plugin}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {diffs.map(diff => (
              <DiffRow
                key={diff.fieldName}
                diff={diff}
                conflictAll={conflictAll}
                columns={columns}
                overrideMap={overrideMap}
                fieldMetaMap={fieldMetaMap}
                editMode={editMode}
                port={port}
                pendingChangeMap={pendingChangeMap}
                onOpen={handleOpen}
                onEdit={handleEdit}
                onRevert={handleRevert}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
