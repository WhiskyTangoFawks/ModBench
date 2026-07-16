import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlagCell } from './FlagCell';
import { FormKeyPicker } from './FormKeyPicker';
import { buildColumns, toStr } from './recordUtils';
import type { Column } from './recordUtils';
import { mono, fg, baseCell, headerCell, toggleBtnStyle, getConflictBg, getCellStyle } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';
import { VmadSection } from './VmadSection';
import type { CompareOverride, CompareResult, ConflictAll, ConflictThis, FieldDiff, FieldMetadata, PendingChange, RecordDetail } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
  mEditBackendPort: number;
};

const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

const getRowBg = (c: ConflictAll): string | undefined => ROW_BG[c];
const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

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
      <FormKeyLink value={value} onOpen={onOpen} />
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
  isHeaderRecord: boolean;
  editMode: boolean;
  saving: boolean;
  showCopyPicker: boolean;
  mutableTargets: PluginInfo[];
  showMasterPicker: boolean;
  loadedPlugins: PluginInfo[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSave: () => void;
  onOpenCopyPicker: () => void;
  onCloseCopyPicker: () => void;
  onCopyTo: (target: string) => void;
  onOpenMasterPicker: () => void;
  onCloseMasterPicker: () => void;
  onAddMaster: (newMasters: string[]) => void;
}

// Issue #86: the header record's "masters" field, pending-aware (a still-unsaved Add Master
// already counts as current — matches the backend's CheckMasterEdit baseline convention).
function currentMasters(o: RecordDetail): string[] {
  const disk = o.fields.find(f => f.metadata.name === 'masters')?.value;
  const pending = o.pendingFields?.masters;
  const value = Array.isArray(pending) ? pending : disk;
  return Array.isArray(value) ? value as string[] : [];
}

function PluginHeader({
  override: o, isImmutable, isHeaderRecord, editMode, saving,
  showCopyPicker, mutableTargets, showMasterPicker, loadedPlugins,
  collapsed, onToggleCollapse,
  onSave, onOpenCopyPicker, onCloseCopyPicker, onCopyTo,
  onOpenMasterPicker, onCloseMasterPicker, onAddMaster,
}: PluginHeaderProps) {
  const masters = currentMasters(o);
  const masterCandidates = loadedPlugins.filter(p => p.name !== o.plugin && !masters.includes(p.name));
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
      {/* Issue #3: left-click the plugin-name chip collapses/expands this column;
          kept as its own click target (not the whole <th>) so it never swallows the
          Save/Copy/Add-Master button clicks below it. */}
      <div onClick={onToggleCollapse} style={{ cursor: 'pointer' }}>{o.plugin}</div>
      {!collapsed && (
        <>
          <div style={{ fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
            [{o.loadOrderIndex}]{o.isWinner ? ' ✓ winner' : ''}
          </div>
          {isImmutable && (
            <div style={{ marginTop: 3, fontSize: '10px', opacity: 0.55, fontStyle: 'italic' }}>
              (read-only)
            </div>
          )}
        </>
      )}
      {!collapsed && editMode && !isImmutable && (
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
          {isHeaderRecord && (
            <>
              <button style={btnStyle} onClick={onOpenMasterPicker}>
                Add Master…
              </button>
              {showMasterPicker && (
                // onMouseDown on items fires before onBlur, so selection works correctly
                <div
                  onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) onCloseMasterPicker(); }}
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
                  {masterCandidates.length === 0 && (
                    <div style={{ padding: '4px 8px', opacity: 0.5, fontSize: '11px' }}>No plugins to add</div>
                  )}
                  {masterCandidates.map(p => (
                    <div
                      key={p.name}
                      onMouseDown={() => { onAddMaster([...masters, p.name]); onCloseMasterPicker(); }}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── ColumnHeaderMenu ──────────────────────────────────────────────────────────

// Issue #3: right-click on a plugin column header. Modeled on DownloadsApp.tsx's
// RowContextMenu (role="menu"/"menuitem", position:fixed at the click coordinates,
// closes on outside click or Escape) — that is this webview's only existing
// context-menu precedent, kept local here since it's mEdit-specific vocabulary
// ("Remove Override"), not shared across the Mod-Management boundary.
interface ColumnHeaderMenuItemProps {
  label: string;
  disabled?: boolean;
  onActivate: () => void;
}

function ColumnHeaderMenuItem({ label, disabled, onActivate }: ColumnHeaderMenuItemProps) {
  const activate = () => { if (!disabled) onActivate(); };
  return (
    <li
      role="menuitem"
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={disabled ? -1 : 0}
      style={{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, padding: baseCell.padding }}
      onClick={activate}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') activate(); }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--vscode-list-hoverBackground,#2a2d2e)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
    >
      {label}
    </li>
  );
}

interface ColumnHeaderMenuProps {
  x: number;
  y: number;
  disabledRemove: boolean;
  onClose: () => void;
  onCopyAllToPending: () => void;
  onCopyAsNewRecord: () => void;
  onRemoveOverride: () => void;
}

function ColumnHeaderMenu({ x, y, disabledRemove, onClose, onCopyAllToPending, onCopyAsNewRecord, onRemoveOverride }: ColumnHeaderMenuProps) {
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

  return (
    <ul
      role="menu"
      style={{
        position: 'fixed',
        top: y,
        left: x,
        listStyle: 'none',
        margin: 0,
        padding: 4,
        // No space after the comma in the var() fallback — see RowContextMenu in
        // DownloadsApp.tsx: happy-dom silently drops color-valued styles containing
        // "var(--x, y)" with a space, but accepts "var(--x,y)".
        backgroundColor: 'var(--vscode-menu-background,#3c3c3c)',
        color: 'var(--vscode-menu-foreground,#ccc)',
        border: '1px solid var(--vscode-menu-border,#454545)',
        borderRadius: 2,
        zIndex: 1000,
      }}
    >
      <ColumnHeaderMenuItem label="Copy All to Pending" onActivate={onCopyAllToPending} />
      <ColumnHeaderMenuItem label="Copy as New Record" onActivate={onCopyAsNewRecord} />
      <ColumnHeaderMenuItem label="Remove Override" disabled={disabledRemove} onActivate={onRemoveOverride} />
    </ul>
  );
}

// ── PluginTargetPicker ────────────────────────────────────────────────────────

// Issue #3: the target-plugin picker for "Copy All to Pending"/"Copy as New Record". More than
// one plugin can be mutable at once (every non-implicit-master plugin in the loadout), so there
// is no single "active editable plugin" to assume — same reason the #86 "Copy as Override…"
// button picker in PluginHeader exists. Positioned/closed like ColumnHeaderMenu (position:fixed
// at the triggering click, closes on outside click or Escape) since it opens from that menu.
interface PluginTargetPickerProps {
  x: number;
  y: number;
  targets: PluginInfo[];
  onClose: () => void;
  onSelect: (plugin: string) => void;
}

function PluginTargetPicker({ x, y, targets, onClose, onSelect }: PluginTargetPickerProps) {
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

  return (
    <ul
      role="menu"
      style={{
        position: 'fixed',
        top: y,
        left: x,
        listStyle: 'none',
        margin: 0,
        padding: 4,
        minWidth: 180,
        maxHeight: 200,
        overflowY: 'auto',
        backgroundColor: 'var(--vscode-menu-background,#3c3c3c)',
        color: 'var(--vscode-menu-foreground,#ccc)',
        border: '1px solid var(--vscode-menu-border,#454545)',
        borderRadius: 2,
        zIndex: 1000,
      }}
    >
      {targets.length === 0 && (
        <li style={{ padding: '4px 8px', opacity: 0.5, fontSize: '11px' }}>No mutable plugins</li>
      )}
      {targets.map(p => (
        <ColumnHeaderMenuItem key={p.name} label={p.name} onActivate={() => onSelect(p.name)} />
      ))}
    </ul>
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

type RowContext =
  | { kind: 'top-level' }
  | { kind: 'array-element'; overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'struct-child';  overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'grandchild';    overrideMeta: FieldMetadata; parentFieldName: string; parentFieldIndex: number };

interface DiffRowProps {
  diff: FieldDiff;
  conflictAll: ConflictAll;
  columns: Column[];
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  editMode: boolean;
  port: number;
  pendingChangeMap: Record<string, PendingChange>;
  collapsedColumns: Set<string>;
  onOpen: (fk: string) => void;
  onEdit: (plugin: string, fieldName: string, value: unknown) => void;
  onRevert: (changeId: string) => void;
  onCellDragStart: (fieldName: string, value: unknown) => void;
  onCellDrop: (fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) => void;
  context: RowContext;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}

function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, editMode, port,
  pendingChangeMap, collapsedColumns, onOpen, onEdit, onRevert,
  onCellDragStart, onCellDrop,
  context, hasChildren, isExpanded, onToggle,
}: DiffRowProps) {
  const meta = context.kind === 'top-level' ? fieldMetaMap[diff.fieldName] : context.overrideMeta;
  if (!meta) return null;

  const pendingLookupField = context.kind === 'top-level' ? diff.fieldName : context.parentFieldName;
  const showActions = context.kind === 'top-level' || context.kind === 'struct-child';

  return (
    <tr style={{ backgroundColor: getRowBg(conflictAll) }}>
      <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.kind !== 'top-level' ? 24 : undefined }}>
        {hasChildren && (
          <button style={toggleBtnStyle} onClick={onToggle}>{isExpanded ? '▼' : '▶'}</button>
        )}
        {diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { override: o } = col;
          const cellStyle = { ...baseCell, ...getCellStyle(diff.cellStates?.[o.plugin]), userSelect: 'text' as const };
          if (collapsedColumns.has(o.plugin)) {
            return <td key={`disk:${o.plugin}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[o.plugin]?.fields.find(f => f.metadata.name === pendingLookupField)?.checkError
            : undefined;
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
          // Issue #3: in edit mode, a leaf field-value cell can be dragged into another
          // plugin's column to stage its value there as a pending change (source may be a
          // read-only column — dragging is a copy, only the drop target's mutability matters,
          // enforced by onCellDrop). onDrop's applyValue re-uses this row's own onEdit closure,
          // which already carries the right merge semantics for this row's context (top-level/
          // array-element/struct-child/grandchild).
          return (
            <td
              key={`disk:${o.plugin}`}
              style={{ ...cellStyle, ...(editMode ? { cursor: 'grab' } : {}) }}
              draggable={editMode}
              onDragStart={editMode ? () => onCellDragStart(diff.fieldName, diff.values[o.plugin]) : undefined}
              onDragOver={editMode ? e => e.preventDefault() : undefined}
              onDrop={editMode ? () => onCellDrop(diff.fieldName, o.plugin, v => onEdit(o.plugin, diff.fieldName, v)) : undefined}
            >
              {renderCell(diff.values[o.plugin], meta, editMode, port, onOpen,
                v => onEdit(o.plugin, diff.fieldName, v), checkError)}
            </td>
          );
        }

        // pending companion column
        const override = overrideMap[col.plugin];
        const rawPending = override?.pendingFields?.[pendingLookupField];
        let pendingValue: unknown;
        switch (context.kind) {
          case 'top-level':
            pendingValue = pendingIfChanged(rawPending, diff.values[col.plugin]);
            break;
          case 'array-element':
            pendingValue = extractPendingElementValue(rawPending, diff.fieldName, context.overrideMeta.isSortable ?? false, diff.values[col.plugin]);
            break;
          case 'struct-child': {
            const sub = (rawPending as Record<string, unknown> | undefined)?.[diff.fieldName];
            pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
            break;
          }
          case 'grandchild': {
            const elem = Array.isArray(rawPending) ? (rawPending as unknown[])[context.parentFieldIndex] : undefined;
            const sub = (elem as Record<string, unknown> | undefined)?.[diff.fieldName];
            pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
            break;
          }
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
                {change && showActions && (
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
  const [masterPickerPlugin, setMasterPickerPlugin] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // Issue #3: collapsed plugin columns, keyed by plugin name. Deliberately NOT reset by the
  // LOAD_RECORD handler below (unlike editMode/copyPickerPlugin/masterPickerPlugin) — collapse
  // state is meant to persist across record-to-record navigation within the same panel session.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  // Issue #3: transient drag payload — doesn't need to trigger a re-render, so a ref rather
  // than state. Cleared on drop (successful or rejected).
  const dragPayloadRef = useRef<{ fieldName: string; value: unknown } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ plugin: string; x: number; y: number } | null>(null);
  // Issue #3: target-plugin picker shared by "Copy All to Pending" and "Copy as New Record" —
  // same UI (position:fixed at the context menu's click coordinates, mutable-plugins-minus-source
  // target list), branching on `mode` only in onSelect.
  const [targetPickerSource, setTargetPickerSource] = useState<{ plugin: string; x: number; y: number; mode: 'copyAll' | 'newRecord' } | null>(null);

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
        setMasterPickerPlugin(null);
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
    await stageChange(plugin, { [fieldName]: value });
  }

  // VMAD structural ops (phase 13.8): stage an op payload under a single change type.
  async function handleVmadStructOp(plugin: string, vmadPath: string, op: unknown) {
    await stageChange(plugin, { [vmadPath]: op }, 'vmad_struct_op');
  }

  async function stageChange(plugin: string, fields: Record<string, unknown>, changeType?: string) {
    setActionError(null);
    const resp = await fetch(`http://localhost:${port}/records/${encodeURIComponent(formKey)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin, fields, source: 'user', ...(changeType ? { changeType } : {}) }),
    });
    if (!resp.ok) {
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const detail = typeof body?.detail === 'string' ? body.detail : '';
        setActionError(detail.toLowerCase().includes('group') ? detail : 'Plugin is read-only');
      } else if (resp.status === 422) {
        const body = await resp.json().catch(() => null) as
          | Array<{ fieldPath?: string; reason?: string; expectedTypes?: string[] }>
          | { detail?: string }
          | null;
        if (Array.isArray(body) && body.length > 0) {
          setActionError(body.map(e => {
            const path = e.fieldPath ?? '?';
            if (e.reason === 'not_in_session') return `${path}: reference not found in session`;
            if (e.reason === 'not_append_only') return `${path}: masters can only be appended to, not reordered or removed`;
            if (e.reason === 'type_mismatch') return `${path}: expected ${(e.expectedTypes ?? []).join('/')}`;
            if (e.reason === 'null_not_allowed') return `${path}: cannot be null`;
            return `${path}: ${e.reason ?? 'invalid'}`;
          }).join('; '));
        } else if (body && !Array.isArray(body) && typeof body.detail === 'string') {
          // ProblemDetails (e.g. ESL-ineligible or read-only fields) — surface the reason verbatim.
          setActionError(body.detail);
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

  // Issue #3: "Remove Override" — stages a delete of this plugin's override of the current
  // record (Phase 10's DeleteRecords endpoint, reached here via the same raw-fetch pattern as
  // handleCopyTo/handleSave — the webview never routes through SessionController/ApiClient).
  async function handleRemoveOverride(plugin: string) {
    setActionError(null);
    try {
      const resp = await fetch(`http://localhost:${port}/records/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ formKey, plugin }] }),
      });
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Remove failed: ${resp.statusText}`);
        return;
      }
      await refresh(formKey);
    } catch (e) {
      setActionError(`Remove failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  function handleOpen(fk: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: fk });
  }

  function handleCellDragStart(fieldName: string, value: unknown) {
    dragPayloadRef.current = { fieldName, value };
  }

  // Issue #3: target must be an editable plugin — reject a drop onto an immutable column as a
  // silent no-op (no PATCH attempt), distinct from typed edits into a read-only cell, which are
  // attempted and surfaced as a 409 by stageChange. Also guards against dropping onto an
  // unrelated field's row (payload fieldName must match the row it's dropped on).
  function handleCellDrop(fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) {
    const payload = dragPayloadRef.current;
    dragPayloadRef.current = null;
    if (!payload || payload.fieldName !== fieldName) return;
    if (immutableSet.has(targetPlugin)) return;
    applyValue(payload.value);
  }

  function toggleColumnCollapse(plugin: string) {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(plugin)) next.delete(plugin); else next.add(plugin);
      return next;
    });
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

  // Issue #3: "Copy All to Pending" — copies every field value from the source column into a
  // pending change for the target plugin (xEdit's "copy as override" from the column header).
  // Declared after overrideMap (not grouped with the other handlers above) — a forward reference
  // to overrideMap from an earlier-declared function broke the React Compiler's ability to
  // preserve overrideMap's own useMemo (react-hooks/preserve-manual-memoization).
  async function handleCopyAllToPending(sourcePlugin: string, targetPlugin: string) {
    const source = overrideMap[sourcePlugin];
    if (!source) return;
    const fields: Record<string, unknown> = {};
    for (const fv of source.fields) fields[fv.metadata.name] = fv.value;
    await stageChange(targetPlugin, fields);
  }

  // Issue #3: "Copy as New Record" — a fresh FormKey in the target plugin, not an override of
  // this one. CreateRecord's TemplateFormKey only templates from the overall winner (EditOrchestrator
  // .CreateRecordCore calls _query.GetRecord(formKey), winner-only), which isn't necessarily this
  // source column's plugin — so instead of relying on TemplateFormKey, create a blank record of the
  // right type, then PATCH every source-column field onto it (mirrors handleCopyAllToPending's field
  // collection, retargeted at the new FormKey).
  async function handleCopyAsNewRecord(sourcePlugin: string, targetPlugin: string) {
    const source = overrideMap[sourcePlugin];
    if (!source) return;
    setActionError(null);
    try {
      const createResp = await fetch(`http://localhost:${port}/plugins/${encodeURIComponent(targetPlugin)}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordType: source.recordType, source: 'user' }),
      });
      if (!createResp.ok) {
        setActionError(createResp.status === 409 ? 'Plugin is read-only' : `Copy failed: ${createResp.statusText}`);
        return;
      }
      const { formKey: newFormKey } = await createResp.json() as { formKey: string };
      const fields: Record<string, unknown> = {};
      for (const fv of source.fields) fields[fv.metadata.name] = fv.value;
      const patchResp = await fetch(`http://localhost:${port}/records/${encodeURIComponent(newFormKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin: targetPlugin, fields, source: 'user' }),
      });
      if (!patchResp.ok) {
        setActionError(`Copy failed: ${patchResp.statusText}`);
      }
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

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
  // Issue #86: the header record lives at the synthetic FormKey "000000:<plugin>" (CONTEXT.md);
  // only it has an editable masters field.
  const isHeaderRecord = formKey.startsWith('000000:');

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
              <th style={{ ...headerCell, textAlign: 'left', minWidth: '160px' }}>Field</th>
              {columns.map(col => {
                if (col.kind === 'disk') {
                  const isCollapsed = collapsedColumns.has(col.override.plugin);
                  return (
                    <th
                      key={`disk:${col.override.plugin}`}
                      style={{ ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px', backgroundColor: getHeaderBg(col.override.conflictThis) }}
                      onContextMenu={e => {
                        e.preventDefault();
                        setContextMenu({ plugin: col.override.plugin, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={immutableSet.has(col.override.plugin)}
                        isHeaderRecord={isHeaderRecord}
                        editMode={editMode}
                        saving={savingPlugin === col.override.plugin}
                        showCopyPicker={copyPickerPlugin === col.override.plugin}
                        mutableTargets={allPlugins.filter(p => !p.isImmutable)}
                        showMasterPicker={masterPickerPlugin === col.override.plugin}
                        loadedPlugins={allPlugins}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.override.plugin)}
                        onSave={() => { void handleSave(col.override.plugin); }}
                        onOpenCopyPicker={() => setCopyPickerPlugin(col.override.plugin)}
                        onCloseCopyPicker={() => setCopyPickerPlugin(null)}
                        onCopyTo={p => { void handleCopyTo(p); }}
                        onOpenMasterPicker={() => setMasterPickerPlugin(col.override.plugin)}
                        onCloseMasterPicker={() => setMasterPickerPlugin(null)}
                        onAddMaster={newMasters => { void handleEdit(col.override.plugin, 'masters', newMasters); }}
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
                  collapsedColumns={collapsedColumns}
                  onCellDragStart={handleCellDragStart}
                  onCellDrop={handleCellDrop}
                  onOpen={handleOpen}
                  onEdit={(plugin, fieldName, value) => { void handleEdit(plugin, fieldName, value); }}
                  onRevert={changeId => { void handleRevert(changeId); }}
                  context={{ kind: 'top-level' }}
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
                        collapsedColumns={collapsedColumns}
                        onCellDragStart={handleCellDragStart}
                        onCellDrop={handleCellDrop}
                        onOpen={handleOpen}
                        onEdit={(plugin, elemKey, newValue) => {
                          void handleEdit(plugin, diff.fieldName, updateArrayAtKey(resolveCurrentArr(plugin), elemKey, newValue, elementMeta.isSortable ?? false));
                        }}
                        onRevert={changeId => { void handleRevert(changeId); }}
                        context={{ kind: 'array-element', overrideMeta: elementMeta, parentFieldName: diff.fieldName }}
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
                            collapsedColumns={collapsedColumns}
                            onCellDragStart={handleCellDragStart}
                            onCellDrop={handleCellDrop}
                            onOpen={handleOpen}
                            onEdit={(plugin, subField, subValue) => {
                              const cur = resolveCurrentArr(plugin);
                              const curElem = (cur[elemIdx] as Record<string, unknown>) ?? {};
                              const updatedArr = [...cur];
                              updatedArr[elemIdx] = { ...curElem, [subField]: subValue };
                              void handleEdit(plugin, diff.fieldName, updatedArr);
                            }}
                            onRevert={changeId => { void handleRevert(changeId); }}
                            context={{ kind: 'grandchild', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName, parentFieldIndex: elemIdx }}
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
                        collapsedColumns={collapsedColumns}
                        onCellDragStart={handleCellDragStart}
                        onCellDrop={handleCellDrop}
                        onOpen={handleOpen}
                        onEdit={(plugin, subField, subValue) => {
                          const disk = (diff.values[plugin] as Record<string, unknown>) ?? {};
                          const pending = overrideMap[plugin]?.pendingFields?.[diff.fieldName] as Record<string, unknown> | undefined;
                          const cur = pending !== undefined ? { ...disk, ...pending } : disk;
                          void handleEdit(plugin, diff.fieldName, { ...cur, [subField]: subValue });
                        }}
                        onRevert={changeId => { void handleRevert(changeId); }}
                        context={{ kind: 'struct-child', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName }}
                      />,
                    );
                  }
                }
              }
              return rows;
            })}
            <VmadSection
                        vmad={result.vmad}
                        columns={columns}
                        onOpen={handleOpen}
                        editMode={editMode}
                        pendingChangeMap={pendingChangeMap}
                        onEdit={(plugin, vmadPath, value) => { void handleEdit(plugin, vmadPath, value); }}
                        onRevert={changeId => { void handleRevert(changeId); }}
                        onStructOp={(plugin, vmadPath, op) => { void handleVmadStructOp(plugin, vmadPath, op); }}
                        port={port}
                      />
          </tbody>
        </table>
      </div>
      {contextMenu && (
        <ColumnHeaderMenu
          x={contextMenu.x}
          y={contextMenu.y}
          disabledRemove={immutableSet.has(contextMenu.plugin)}
          onClose={() => setContextMenu(null)}
          onCopyAllToPending={() => { setTargetPickerSource({ ...contextMenu, mode: 'copyAll' }); setContextMenu(null); }}
          onCopyAsNewRecord={() => { setTargetPickerSource({ ...contextMenu, mode: 'newRecord' }); setContextMenu(null); }}
          onRemoveOverride={() => { const plugin = contextMenu.plugin; setContextMenu(null); void handleRemoveOverride(plugin); }}
        />
      )}
      {targetPickerSource && (
        <PluginTargetPicker
          x={targetPickerSource.x}
          y={targetPickerSource.y}
          targets={allPlugins.filter(p => !p.isImmutable && p.name !== targetPickerSource.plugin)}
          onClose={() => setTargetPickerSource(null)}
          onSelect={target => {
            const { plugin: source, mode } = targetPickerSource;
            setTargetPickerSource(null);
            if (mode === 'copyAll') void handleCopyAllToPending(source, target);
            else void handleCopyAsNewRecord(source, target);
          }}
        />
      )}
    </div>
  );
}
