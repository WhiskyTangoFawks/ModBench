import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { ColumnEdge } from './ColumnEdge';
import { DiffRow, type FocusedCell } from './DiffRow';
import { buildColumns, wirePath, headerCellContext, combineVscodeContexts, recordLabel } from './recordUtils';
import { mono, fg, headerCell, headerBackground, DIMMED_OPACITY, COLLAPSED_COLUMN_WIDTH, columnWidthStyle } from './gridStyles';
import type {
  ColumnKey, CompareOverride, CompareResult, PathHop, PluginLoadFailure, RecordEditEnvelope,
} from './types';
import { columnKey, LABEL_COLUMN } from './columnKey';
import { addElement, editField, focusCell, focusedCellContext } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, parseExtensionToWebview } from '../../src/wire/messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { recordPanelLoadFailureMessage } from './recordPanelLoadFailureMessage';
import { RecordHeaderRow, FormIdRow } from './RecordHeaderRows';
import { navigate } from './gridNavigation';
import { recordRows, visibleRows, navRows, RECORD_HEADER_ROW, FORM_ID_PATH, type FieldRow, type RecordRow } from './recordRows';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey?: string;
};

// One sweep over the response's own overrides, keyed as the backend keys its dictionaries
// (ADR-0012), so every whole-grid column set is minted the same way.
function columnKeysWhere(
  overrides: CompareOverride[] | undefined, holds: (o: CompareOverride, key: ColumnKey) => boolean,
): Set<ColumnKey> {
  const keys = new Set<ColumnKey>();
  for (const o of overrides ?? []) {
    const key = columnKey(o.plugin, o.origin);
    if (holds(o, key)) keys.add(key);
  }
  return keys;
}

// ── RecordPanel ───────────────────────────────────────────────────────────────

const messageStyle: React.CSSProperties = {
  flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-editorWarning-foreground, #cca700)',
  padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)', borderRadius: 2,
};

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [gone, setGone] = useState(false);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // Null until /plugins answers, and null again when it fails: fail-closed, so a panel that has
  // not heard from /plugins offers no editing, compile or track (commands.md, No dead entries).
  const [trackedSet, setTrackedSet] = useState<Set<ColumnKey> | null>(null);
  // Whether the winner sweep has run. Initial `true` only matters until the first load
  // lands, so it can never read as a false "settled".
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [loadFailures, setLoadFailures] = useState<PluginLoadFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  const toggleRow = (rowKey: string) => setCollapsedRows(prev => {
    const next = new Set(prev);
    if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
    return next;
  });
  // The one focused cell (editor.md, The focused cell).
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  const enteredCell = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const headerRow = useRef<HTMLTableRowElement>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey | null) {
    enteredCell.current = true;
    setFocusedCell({ rowKey, plugin });
  }
  // Read off the rendered grid after every render, since a re-read or a move changes what the
  // focused cell's menu would offer without a new focus. Only a user's focus enters the grid.
  const toldFocusedCell = useRef<string | undefined>(undefined);
  const editorOpen = useRef(false);
  const tellFocusedCell = useCallback((entered: boolean) => {
    const cell = focusedCellContext(document);
    const context = cell && editorOpen.current ? { ...cell, editorOpen: true } : cell;
    const told = JSON.stringify(context);
    if (told === toldFocusedCell.current && !entered) return;
    toldFocusedCell.current = told;
    focusCell(context, entered);
  }, []);
  useEffect(() => {
    const entered = enteredCell.current;
    enteredCell.current = false;
    tellFocusedCell(entered);
  });
  // editor.md, The focused cell, story 7: the grid's keys wait while an editor is open. An editor
  // holds the focus from opening to closing, and leaving the panel closes it.
  useEffect(() => {
    const follow = (gaining: EventTarget | null) => {
      const open = gaining instanceof Element && gaining.closest('[data-editor]') !== null;
      if (open === editorOpen.current) return;
      editorOpen.current = open;
      tellFocusedCell(false);
    };
    const focusIn = (e: FocusEvent) => follow(e.target);
    const focusOut = (e: FocusEvent) => follow(e.relatedTarget);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    return () => {
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
    };
  }, [tellFocusedCell]);
  // Keyed by column identity — two same-filename columns must collapse independently.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  const [columnWidths, setColumnWidths] = useState<ReadonlyMap<ColumnKey | typeof LABEL_COLUMN, number>>(new Map());
  const resizeColumn = (key: ColumnKey | typeof LABEL_COLUMN, width: number) => setColumnWidths(prev => new Map(prev).set(key, width));
  // One definition of "this column can be written" (ADR-0007), computed for the whole grid at
  // once, since per cell it would lag. The backend refuses every write to a parse-failed record,
  // so a diagnosis vetoes it too.
  const editableColumns = useMemo(() => columnKeysWhere(result?.overrides, (o, key) =>
    !immutableSet.has(key) && trackedSet?.has(key) === true && o.parseDiagnosis == null),
    [result, immutableSet, trackedSet]);

  // editor.md, A column's header: a Partial Form column is dimmed, header and cells alike. One
  // definition of a column's look, so the header and the cells cannot disagree.
  const partialFormColumns = useMemo(() => columnKeysWhere(result?.overrides, o => o.isPartialForm), [result]);
  const columnStyle = useCallback((key: ColumnKey | typeof LABEL_COLUMN): React.CSSProperties => ({
    ...(key !== LABEL_COLUMN && partialFormColumns.has(key) ? { opacity: DIMMED_OPACITY } : {}),
    ...columnWidthStyle(key !== LABEL_COLUMN && collapsedColumns.has(key) ? COLLAPSED_COLUMN_WIDTH : columnWidths.get(key)),
  }), [partialFormColumns, collapsedColumns, columnWidths]);

  // The column key alone is a rendering key; the override carries the compound identity (ADR-0012)
  // the write path needs and the values a wire path resolves against.
  const overrideFor = useCallback(
    (plugin: ColumnKey) => (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin),
    [result]);

  const post = useCallback((plugin: ColumnKey, envelope: RecordEditEnvelope) => {
    const override = overrideFor(plugin);
    if (!override) return;
    editField(formKey, override.plugin, override.origin, envelope);
  }, [overrideFor, formKey]);

  // An answer lands only if no later read was asked for since: reads answer out of order.
  const latestRead = useRef(0);
  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    const read = ++latestRead.current;
    try {
      const loaded = await client.load(fk);
      if (read !== latestRead.current) return;
      if (!loaded.ok) throw new Error(loaded.error);
      setError(null);
      setResult(loaded.result);
      setGone(loaded.result === null);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
      // Unguarded, unlike the two above: a null must replace a previous record's answer, so an
      // unknown state reads as neither tracked nor untracked.
      setTrackedSet(loaded.trackedSet);
      // No `?? true` fallback: `undefined` is falsy, so a fixture that omits `conflictsComputed`
      // still shows the banner rather than reading as settled.
      setConflictsComputed(loaded.conflictsComputed);
      setLoadFailures(loaded.loadFailures);
    } catch (e) {
      if (read === latestRead.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  // The tab's first read. Every read after it is the host's to ask for (editor.md, States, story 5).
  useEffect(() => { if (latestRead.current === 0) void refresh(formKey); }, [formKey, refresh]);

  function toggleColumnCollapse(key: ColumnKey) {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // One leaf, one set (ADR-0005).
  const handleCellCommit = useCallback((plugin: ColumnKey, hops: PathHop[], value: unknown) => {
    post(plugin, { op: 'set', path: hops, value });
  }, [post]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      let msg;
      try {
        msg = parseExtensionToWebview(event.data);
      } catch {
        return; // Not one of ours, or a stale/mismatched build.
      }
      if (msg.type !== EXTENSION_TO_WEBVIEW.LOAD_RECORD) return;
      setFormKey(msg.formKey);
      void refresh(msg.formKey);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh]);

  const loadFailureMessage = recordPanelLoadFailureMessage(loadFailures, result?.overrides ?? []);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
  );
  const rows = useMemo(
    () => result ? recordRows({ result, columns, editableColumns, partialFormColumns }) : [],
    [result, columns, editableColumns, partialFormColumns],
  );

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    padding: '12px',
    fontFamily: mono,
    fontSize: '12px',
    color: fg,
  };

  if (gone) {
    return (
      <div style={containerStyle}>
        {formKey} is gone.{error && ` The last read failed: ${error}`}
      </div>
    );
  }
  if (!result) {
    return (
      <div style={{ ...containerStyle, color: error ? 'var(--vscode-errorForeground, #f44)' : fg }}>
        {error && `Failed to load: ${error}`}
      </div>
    );
  }

  // `result.conflictAll` is record-wide and deliberately not threaded into the row background —
  // that is each row's own `diff.conflictAll`, computed bottom-up per node.
  const { overrides } = result;

  const title = recordLabel(overrides, formKey);

  const headerExpanded = !collapsedRows.has(RECORD_HEADER_ROW);
  const navColumns = columns.filter(c => !collapsedColumns.has(c.key)).map(c => c.key);

  function handleGridKey(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !focusedCell) return;
    if (e.target instanceof Element && e.target.closest('[data-editor]')) return;
    const rowHeight = e.currentTarget.querySelector('tr')?.offsetHeight ?? 0;
    const viewport = (scroller.current?.clientHeight ?? 0) - (headerRow.current?.offsetHeight ?? 0);
    const page = rowHeight > 0 ? Math.max(1, Math.floor(viewport / rowHeight) - 1) : 1;
    const move = navigate(e.key, navRows(rows, collapsedRows), navColumns, focusedCell, page);
    if (!move) return;
    e.preventDefault();
    if ('toggle' in move) toggleRow(move.toggle);
    else handleFocusCell(move.focus.rowKey, move.focus.plugin);
  }

  function renderRow(row: FieldRow) {
    const { key, diff, meta, path, rootField, parent } = row;
    return (
      <DiffRow
        key={key}
        diff={diff}
        meta={meta}
        columns={columns}
        columnStyle={columnStyle}
        editableColumns={row.editable}
        onEditCell={(plugin: ColumnKey, value: unknown) => {
          const hops = wirePath(rootField, path, plugin);
          if (hops) handleCellCommit(plugin, hops, value);
        }}
        onAddElement={addElement}
        collapsedColumns={collapsedColumns}
        recordLabel={title}
        context={{ path, rootField, depth: row.depth }}
        rowKey={key}
        parentRowKey={parent}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        isExpanded={!collapsedRows.has(key)}
        isLastElement={row.isLastElement}
        keyMembers={row.keyMembers}
        ownerPresent={row.present}
        cellMetas={row.cellMetas}
        onToggle={() => toggleRow(key)}
      />
    );
  }

  // The FormID reads each copy's own FormKey, and edits as the FormKey typed.
  const renderFormId = (row: Extract<RecordRow, { kind: 'formId' }>) => (
    <FormIdRow
      key={row.key}
      label={row.meta.displayLabel ?? row.meta.name}
      readOnlyReason={row.meta.readOnlyReason}
      columns={columns}
      collapsedColumns={collapsedColumns}
      columnStyle={columnStyle}
      editableColumns={editableColumns}
      focusedCell={focusedCell}
      onFocusCell={handleFocusCell}
      onCommitFormId={(plugin, value) => handleCellCommit(plugin, FORM_ID_PATH, value)}
    />
  );

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600 }}>
        {`${result.recordTypeName} ${title}`}
      </div>
      {error && <div style={messageStyle}>Showing the last good read: {error}</div>}
      {/* See recordPanelIncompleteMessage. Clears itself with no user action once refresh() next
          lands a settled `conflictsComputed`. */}
      {loadFailureMessage && <div style={messageStyle}>{loadFailureMessage}</div>}
      {recordPanelIncompleteMessage(conflictsComputed) && (
        <div style={messageStyle}>{recordPanelIncompleteMessage(conflictsComputed)}</div>
      )}
      {/* flex:1 + minHeight:0 lets this wrapper shrink to the remaining viewport space (the
          flex-item default of min-height:auto would defeat that). overflow:auto then keeps the
          horizontal scrollbar reachable at any scroll position. */}
      <div ref={scroller} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr ref={headerRow}>
              <th style={{ ...headerCell, position: 'relative', textAlign: 'left', ...columnStyle(LABEL_COLUMN) }}>
                Field<ColumnEdge onResize={width => resizeColumn(LABEL_COLUMN, width)} />
              </th>
              {columns.map(col => {
                // Keyed by col.key (ADR-0012), so two columns that share a file name collapse,
                // resize and read-only apart.
                const isImmutable = immutableSet.has(col.key);
                const tracked = trackedSet?.has(col.key) === true;
                return (
                  <PluginHeader
                    key={col.key}
                    override={col.override}
                    isImmutable={isImmutable}
                    isTracked={tracked}
                    collapsed={collapsedColumns.has(col.key)}
                    onToggleCollapse={() => toggleColumnCollapse(col.key)}
                    onResize={width => resizeColumn(col.key, width)}
                    style={{ backgroundColor: headerBackground(col.override.conflictThis), ...columnStyle(col.key) }}
                    // Copy… is offered on every column: copying from a read-only plugin is the
                    // ordinary case.
                    vscodeContext={combineVscodeContexts(
                      headerCellContext(
                        col.override.formKey, col.override.plugin, col.override.origin, tracked && !isImmutable,
                      ),
                    )}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody onKeyDown={handleGridKey}>
            <RecordHeaderRow
              columns={columns}
              collapsedColumns={collapsedColumns}
              columnStyle={columnStyle}
              expanded={headerExpanded}
              onToggle={() => toggleRow(RECORD_HEADER_ROW)}
              focusedCell={focusedCell}
              onFocusCell={handleFocusCell}
            />
            {visibleRows(rows, collapsedRows).map(row => row.kind === 'formId' ? renderFormId(row) : renderRow(row))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
