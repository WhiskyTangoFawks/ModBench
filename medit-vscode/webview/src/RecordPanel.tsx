import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlagCell } from './FlagCell';
import { FormKeyPicker } from './FormKeyPicker';
import { buildColumns, toStr } from './recordUtils';
import type { Column } from './recordUtils';
import type { CompareOverride, CompareResult, ConflictAll, ConflictThis, FieldDiff, FieldMetadata, PendingChange, RecordDetail } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

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

const toggleBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: fg,
  fontFamily: mono,
  fontSize: '11px',
  padding: '0 3px 0 0',
  lineHeight: 1,
};

const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

const CONFLICT_RGB: Partial<Record<ConflictThis, string>> = {
  IdenticalToMaster: '150,150,150',
  Override:          '76,175,80',
  ConflictWins:      '255,152,0',
  ConflictLoses:     '244,67,54',
};

const getConflictBg = (c: ConflictThis | undefined, alpha: number): string | undefined => {
  const rgb = c !== undefined ? CONFLICT_RGB[c] : undefined;
  return rgb ? `rgba(${rgb},${alpha})` : undefined;
};

const getRowBg = (c: ConflictAll): string | undefined => ROW_BG[c];
const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

function getCellStyle(cellState: ConflictThis | undefined): React.CSSProperties {
  const bg = getConflictBg(cellState, 0.18);
  if (!bg) return {};
  if (cellState === 'ConflictLoses') return { backgroundColor: bg, color: 'rgba(244,67,54,1)' };
  return { backgroundColor: bg };
}

// ── ScalarCell ────────────────────────────────────────────────────────────────

interface ScalarCellProps {
  value: unknown;
  meta: FieldMetadata;
  editMode: boolean;
  onCommit: (v: unknown) => void;
}

export function ScalarCell({ value, meta, editMode, onCommit }: ScalarCellProps) {
  const [draft, setDraft] = useState(() => toStr(value));
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(toStr(value));
  }

  if (!editMode) {
    return value == null
      ? <span style={{ opacity: 0.35 }}>—</span>
      : <span>{toStr(value)}</span>;
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

// ── CheckErrorIcon ───────────────────────────────────────────────────────────

export function CheckErrorIcon({ checkError }: { checkError?: string | null }) {
  if (!checkError) return null;
  return (
    <span
      title={checkError}
      style={{
        color: 'var(--vscode-errorForeground, #f88)',
        fontSize: '11px',
        marginLeft: 4,
        cursor: 'default',
      }}
    >⚠</span>
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
  checkError?: string | null;
}

export function FormKeyCell({ value, meta, editMode, port, onOpen, onCommit, checkError }: FormKeyCellProps) {
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
      <span style={{ display: 'inline-flex', alignItems: 'center', width: '100%' }}>
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
        <CheckErrorIcon checkError={checkError} />
      </span>
    );
  }

  if (typeof value !== 'string' || !value) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <span style={{ opacity: 0.35 }}>—</span>
        <CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
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
      <CheckErrorIcon checkError={checkError} />
    </span>
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
  checkError?: string | null,
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} editMode={editMode} port={port}
        onOpen={onOpen} onCommit={fk => onCommit(fk)} checkError={checkError}
      />
    );
  }
  if (meta.type === 'array') {
    return (
      <span style={{ opacity: 0.5 }}>
        {Array.isArray(value) ? `[${(value as unknown[]).length}]` : '[…]'}
      </span>
    );
  }
  // struct fields in the diff table are handled via sub-rows; StructRowGroup is used by ArrayRowGroup
  if (meta.type === 'struct') {
    return (
      <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
        {'{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return <FlagCell value={value} meta={meta} editMode={editMode} onCommit={onCommit} />;
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
              onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onCloseCopyPicker(); }}
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
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ''; }}
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

// ── Array child helpers ───────────────────────────────────────────────────────

function parseElementIndex(fieldName: string): number {
  return Number.parseInt(fieldName.slice(1, -1), 10);
}

function pendingIfChanged(pending: unknown, disk: unknown): unknown {
  if (pending === undefined) return undefined;
  if (pending === disk) return undefined;
  if (JSON.stringify(pending) === JSON.stringify(disk)) return undefined;
  return pending;
}

function extractPendingElementValue(
  rawPending: unknown,
  fieldName: string,
  isSortable: boolean,
  diskValue: unknown,
): unknown {
  if (!Array.isArray(rawPending)) return undefined;
  let pending: unknown;
  if (isSortable) {
    if (!(rawPending as unknown[]).includes(fieldName)) return undefined;
    pending = fieldName;
  } else {
    const idx = parseElementIndex(fieldName);
    if (idx >= (rawPending as unknown[]).length) return undefined;
    pending = (rawPending as unknown[])[idx];
  }
  return pendingIfChanged(pending, diskValue);
}

function updateArrayAtKey(
  array: unknown[],
  elementKey: string,
  newValue: unknown,
  isSortable: boolean,
): unknown[] {
  if (isSortable) {
    return array.map(e => (e === elementKey ? newValue : e));
  }
  const idx = parseElementIndex(elementKey);
  return array.map((e, i) => (i === idx ? newValue : e));
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
  depth?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  overrideMeta?: FieldMetadata;
  parentFieldName?: string;
  parentFieldIndex?: number;
  parentMeta?: FieldMetadata;
}

function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, editMode, port,
  pendingChangeMap, onOpen, onEdit, onRevert,
  depth = 0, hasChildren, isExpanded, onToggle, overrideMeta, parentFieldName, parentFieldIndex, parentMeta,
}: DiffRowProps) {
  const meta = overrideMeta ?? fieldMetaMap[diff.fieldName];
  if (!meta) return null;

  const isArrayElement = depth > 0 && parentMeta?.type === 'array';
  const isGrandchild = parentFieldIndex !== undefined;

  return (
    <tr style={{ backgroundColor: getRowBg(conflictAll) }}>
      <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: depth > 0 ? 24 : undefined }}>
        {hasChildren && (
          <button style={toggleBtnStyle} onClick={onToggle}>{isExpanded ? '▼' : '▶'}</button>
        )}
        {diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { override: o } = col;
          const cellStyle = { ...baseCell, ...getCellStyle(diff.cellStates?.[o.plugin]), userSelect: 'text' as const };
          const checkErrorFieldName = parentFieldName ?? diff.fieldName;
          const checkError = isArrayElement || isGrandchild
            ? undefined
            : overrideMap[o.plugin]?.fields.find(f => f.metadata.name === checkErrorFieldName)?.checkError;
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[o.plugin])
              ? (diff.values[o.plugin] as unknown[]).length
              : '…';
            const collapsedLabel = meta.type === 'array' ? `[${len}]` : '{…}';
            return (
              <td key={`disk:${o.plugin}`} style={cellStyle}>
                {isExpanded ? null : (
                  <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </td>
            );
          }
          return (
            <td key={`disk:${o.plugin}`} style={cellStyle}>
              {renderCell(diff.values[o.plugin], meta, editMode, port, onOpen,
                v => onEdit(o.plugin, diff.fieldName, v), checkError)}
            </td>
          );
        }

        // pending companion column
        const override = overrideMap[col.plugin];
        const pendingLookupField = parentFieldName ?? diff.fieldName;
        const rawPending = override?.pendingFields?.[pendingLookupField];
        let pendingValue: unknown;
        if (isArrayElement) {
          pendingValue = extractPendingElementValue(rawPending, diff.fieldName, overrideMeta?.isSortable ?? false, diff.values[col.plugin]);
        } else if (isGrandchild || parentFieldName !== undefined) {
          let obj: unknown;
          if (isGrandchild) {
            obj = Array.isArray(rawPending) ? (rawPending as unknown[])[parentFieldIndex] : undefined;
          } else {
            obj = rawPending;
          }
          const sub = (obj as Record<string, unknown> | undefined)?.[diff.fieldName];
          pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
        } else {
          pendingValue = rawPending;
        }
        const change = pendingChangeMap[`${col.plugin}:${pendingLookupField}`];
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
                <span>{toStr(pendingValue)}</span>
                {change && !isArrayElement && !isGrandchild && (
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
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());

  const port = mEditWindow.mEditBackendPort;

  const refresh = useCallback(async (fk: string) => {
    if (!fk || !port) return;
    try {
      setError(null);
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

  const refreshRef = useRef(refresh);
  useLayoutEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey, port] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

  // Listen for loadRecord messages from extension (panel reuse)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebview;
      if (msg.type === EXTENSION_TO_WEBVIEW.LOAD_RECORD) {
        if (msg.formKey !== prevFormKeyRef.current) {
          // formKey will change → [formKey, port] effect will fire; skip it.
          skipNextRefreshEffect.current = true;
        }
        setFormKey(msg.formKey);
        setResult(null);
        setAllChanges([]);
        setError(null);
        setActionError(null);
        setEditMode(false);
        setSavingPlugin(null);
        setCopyPickerPlugin(null);
        void refreshRef.current(msg.formKey);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    prevFormKeyRef.current = formKey;
    if (!formKey || !port) return;
    if (skipNextRefreshEffect.current) { skipNextRefreshEffect.current = false; return; }
    void refreshRef.current(formKey);
  }, [formKey, port]);

  async function handleEdit(plugin: string, fieldName: string, value: unknown) {
    setActionError(null);
    const resp = await fetch(`http://localhost:${port}/records/${encodeURIComponent(formKey)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin, fields: { [fieldName]: value }, source: 'user' }),
    });
    if (!resp.ok) {
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const detail = typeof body?.detail === 'string' ? body.detail : '';
        setActionError(detail.toLowerCase().includes('group') ? detail : 'Plugin is read-only');
      } else if (resp.status === 422) {
        const errors = await resp.json().catch(() => []) as Array<{ fieldPath?: string; reason?: string; expectedTypes?: string[] }>;
        if (Array.isArray(errors) && errors.length > 0) {
          setActionError(errors.map(e => {
            const path = e.fieldPath ?? '?';
            if (e.reason === 'not_in_session') return `${path}: reference not found in session`;
            if (e.reason === 'type_mismatch') return `${path}: expected ${(e.expectedTypes ?? []).join('/')}`;
            if (e.reason === 'null_not_allowed') return `${path}: cannot be null`;
            return `${path}: ${e.reason ?? 'invalid'}`;
          }).join('; '));
        } else {
          setActionError('Invalid reference');
        }
      } else {
        setActionError(`Error: ${resp.statusText}`);
      }
      return;
    }
    await refresh(formKey);
  }

  async function handleRevert(changeId: string) {
    setActionError(null);
    const resp = await fetch(`http://localhost:${port}/changes/${changeId}`, { method: 'DELETE' });
    if (!resp.ok) {
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const detail = typeof body?.detail === 'string' ? body.detail : '';
        setActionError(detail || `Revert failed: ${resp.statusText}`);
      } else {
        setActionError(`Revert failed: ${resp.statusText}`);
      }
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

  const fieldMetaMap = useMemo((): Record<string, FieldMetadata> => {
    const map: Record<string, FieldMetadata> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    return map;
  }, [result]);

  const overrideMap = useMemo((): Record<string, CompareOverride> => {
    const map: Record<string, CompareOverride> = {};
    for (const o of result?.overrides ?? []) map[o.plugin] = o;
    return map;
  }, [result]);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides, immutableSet) : [],
    [result, immutableSet],
  );

  const pendingChangeMap = useMemo((): Record<string, PendingChange> => {
    const map: Record<string, PendingChange> = {};
    for (const c of allChanges) map[`${c.plugin}:${c.fieldPath}`] = c;
    return map;
  }, [allChanges]);

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
                    <th key={`disk:${col.override.plugin}`} style={{ ...baseCell, fontWeight: 600, textAlign: 'left', minWidth: '200px', backgroundColor: getHeaderBg(col.override.conflictThis) }}>
                      <PluginHeader
                        override={col.override}
                        isImmutable={immutableSet.has(col.override.plugin)}
                        editMode={editMode}
                        saving={savingPlugin === col.override.plugin}
                        showCopyPicker={copyPickerPlugin === col.override.plugin}
                        mutableTargets={allPlugins.filter(p => !p.isImmutable)}
                        onSave={() => { void handleSave(col.override.plugin); }}
                        onOpenCopyPicker={() => setCopyPickerPlugin(col.override.plugin)}
                        onCloseCopyPicker={() => setCopyPickerPlugin(null)}
                        onCopyTo={p => { void handleCopyTo(p); }}
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
            {diffs.flatMap(diff => {
              const hasChildren = (diff.children?.length ?? 0) > 0;
              const isExpanded = expandedStructs.has(diff.fieldName);
              const rows: React.ReactNode[] = [
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
                  onEdit={(plugin, fieldName, value) => { void handleEdit(plugin, fieldName, value); }}
                  onRevert={changeId => { void handleRevert(changeId); }}
                  hasChildren={hasChildren}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedStructs(prev => {
                    const next = new Set(prev);
                    if (next.has(diff.fieldName)) next.delete(diff.fieldName);
                    else next.add(diff.fieldName);
                    return next;
                  })}
                />,
              ];
              if (hasChildren && isExpanded) {
                const parentMeta = fieldMetaMap[diff.fieldName];
                const elementType = parentMeta?.type === 'array' ? parentMeta.elementType : undefined;
                for (const child of diff.children ?? []) {
                  if (elementType != null) {
                    const elementMeta = elementType;
                    const childKey = `${diff.fieldName}.${child.fieldName}`;
                    const elemExpanded = expandedStructs.has(childKey);
                    const elemIdx = parseElementIndex(child.fieldName);
                    const resolveCurrentArr = (plugin: string): unknown[] => {
                      const diskArr = (diff.values[plugin] as unknown[]) ?? [];
                      const pendingArr = overrideMap[plugin]?.pendingFields?.[diff.fieldName] as unknown[] | undefined;
                      return pendingArr ?? diskArr;
                    };
                    rows.push(
                      <DiffRow
                        key={childKey}
                        diff={child}
                        conflictAll={conflictAll}
                        columns={columns}
                        overrideMap={overrideMap}
                        fieldMetaMap={fieldMetaMap}
                        editMode={editMode}
                        port={port}
                        pendingChangeMap={pendingChangeMap}
                        onOpen={handleOpen}
                        onEdit={(plugin, elemKey, newValue) => {
                          void handleEdit(plugin, diff.fieldName, updateArrayAtKey(resolveCurrentArr(plugin), elemKey, newValue, elementMeta.isSortable ?? false));
                        }}
                        onRevert={changeId => { void handleRevert(changeId); }}
                        depth={1}
                        overrideMeta={elementMeta}
                        parentFieldName={diff.fieldName}
                        parentMeta={parentMeta}
                        hasChildren={(child.children?.length ?? 0) > 0}
                        isExpanded={elemExpanded}
                        onToggle={() => setExpandedStructs(prev => {
                          const next = new Set(prev);
                          if (next.has(childKey)) next.delete(childKey); else next.add(childKey);
                          return next;
                        })}
                      />,
                    );
                    // Grandchild rows: struct sub-fields of struct-typed array elements
                    if ((child.children?.length ?? 0) > 0 && elemExpanded) {
                      for (const grandchild of child.children ?? []) {
                        const subFieldMeta = elementMeta.fields?.find(f => f.name === grandchild.fieldName);
                        rows.push(
                          <DiffRow
                            key={`${childKey}.${grandchild.fieldName}`}
                            diff={grandchild}
                            conflictAll={conflictAll}
                            columns={columns}
                            overrideMap={overrideMap}
                            fieldMetaMap={fieldMetaMap}
                            editMode={editMode}
                            port={port}
                            pendingChangeMap={pendingChangeMap}
                            onOpen={handleOpen}
                            onEdit={(plugin, subField, subValue) => {
                              const cur = resolveCurrentArr(plugin);
                              const curElem = (cur[elemIdx] as Record<string, unknown>) ?? {};
                              const updatedArr = [...cur];
                              updatedArr[elemIdx] = { ...curElem, [subField]: subValue };
                              void handleEdit(plugin, diff.fieldName, updatedArr);
                            }}
                            onRevert={changeId => { void handleRevert(changeId); }}
                            depth={2}
                            overrideMeta={subFieldMeta}
                            parentFieldName={diff.fieldName}
                            parentFieldIndex={elemIdx}
                            parentMeta={elementMeta}
                          />,
                        );
                      }
                    }
                  } else {
                    // Struct children
                    const subFieldMeta = parentMeta?.fields?.find(f => f.name === child.fieldName);
                    rows.push(
                      <DiffRow
                        key={`${diff.fieldName}.${child.fieldName}`}
                        diff={child}
                        conflictAll={conflictAll}
                        columns={columns}
                        overrideMap={overrideMap}
                        fieldMetaMap={fieldMetaMap}
                        editMode={editMode}
                        port={port}
                        pendingChangeMap={pendingChangeMap}
                        onOpen={handleOpen}
                        onEdit={(plugin, subField, subValue) => {
                          const disk = (diff.values[plugin] as Record<string, unknown>) ?? {};
                          const pending = overrideMap[plugin]?.pendingFields?.[diff.fieldName] as Record<string, unknown> | undefined;
                          const cur = pending !== undefined ? { ...disk, ...pending } : disk;
                          void handleEdit(plugin, diff.fieldName, { ...cur, [subField]: subValue });
                        }}
                        onRevert={changeId => { void handleRevert(changeId); }}
                        depth={1}
                        overrideMeta={subFieldMeta}
                        parentFieldName={diff.fieldName}
                        parentMeta={parentMeta}
                      />,
                    );
                  }
                }
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
