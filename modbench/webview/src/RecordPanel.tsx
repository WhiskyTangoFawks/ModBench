import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { ColumnEdge } from './ColumnEdge';
import { DiffRow } from './DiffRow';
import { buildColumns, headerCellContext, recordLabel } from './recordUtils';
import { mono, fg, headerCell, headerBackground, DIMMED_OPACITY, COLLAPSED_COLUMN_WIDTH, columnWidthStyle } from './gridStyles';
import type {
  ColumnKey, CompareOverride, CompareResult, PathHop, PluginLoadFailure, RecordEditEnvelope,
} from './types';
import { LABEL_COLUMN } from './labelColumn';
import { columnKey, copyColumnKey } from '../../src/wire/columnKey';
import { pluginAddressOf } from '../../src/wire/pluginAddress';
import { addElement, editField, focusCell, keepViewState, openInPlace } from './nativeBridge';
import { openEditor } from './DiskCell';
import { EditorMounted } from './cellEditor';
import { pastedValue } from './modelValue';
import { EXTENSION_TO_WEBVIEW, isViewState, parseExtensionToWebview, type ColumnCopy, type ViewState } from '../../src/wire/messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { recordPanelLoadFailureMessage } from './recordPanelLoadFailureMessage';
import { RecordHeaderRow, FormIdRow } from './RecordHeaderRows';
import { navigate, type FocusedCell } from './gridNavigation';
import { recordRows, shownCell, visibleRows, navRows, FORM_ID_PATH, type GridCell, type RecordRow, type ValueCell } from './recordRows';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey?: string;
  mEditLoadError?: string;
  mEditViewState?: unknown;
};

// The place of the tab this one stands in for, which an edit's move of the file closed.
const placeGiven = (): ViewState => (isViewState(mEditWindow.mEditViewState)
  ? mEditWindow.mEditViewState
  : { collapsedRows: [], collapsedColumns: [], focusedCell: null, scroll: { top: 0, left: 0 } });

// One sweep over the response's own overrides, keyed as the backend keys its dictionaries
// (ADR-0012), so every whole-grid column set is minted the same way.
function columnKeysWhere(overrides: CompareOverride[] | undefined, holds: (o: CompareOverride) => boolean): Set<ColumnKey> {
  return new Set((overrides ?? []).filter(holds).map(copyColumnKey));
}

// A column's status is its plugin's (editor.md, A column's header).
const pluginKeyOf = (o: CompareOverride): ColumnKey => columnKey(pluginAddressOf(o));

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
  const [sourceUnreadableSet, setSourceUnreadableSet] = useState<Set<ColumnKey> | null>(null);
  // Whether the winner sweep has run. Initial `true` only matters until the first load
  // lands, so it can never read as a false "settled".
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [loadFailures, setLoadFailures] = useState<PluginLoadFailure[]>([]);
  const [fileColumn, setFileColumn] = useState<ColumnKey | undefined>(undefined);
  const [error, setError] = useState<string | null>(mEditWindow.mEditLoadError ?? null);
  const [given] = useState(placeGiven);
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(() => new Set(given.collapsedRows));
  const toggleRow = (rowKey: string) => setCollapsedRows(prev => {
    const next = new Set(prev);
    if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
    return next;
  });
  // The one focused cell (editor.md, The focused cell).
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(given.focusedCell);
  const enteredCell = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const headerRow = useRef<HTMLTableRowElement>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey | null) {
    enteredCell.current = true;
    setFocusedCell({ rowKey, plugin });
  }
  // editor.md, The focused cell, story 7: the grid's keys wait while an editor is open.
  const [editorOpen, setEditorOpen] = useState(false);
  const editorMounted = useCallback((editor: HTMLElement | null) => setEditorOpen(editor !== null), []);
  // Keyed by column identity — two same-filename columns must collapse independently.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(() => new Set(given.collapsedColumns));
  const scrolled = useRef(given.scroll);
  const toldPlace = useRef(JSON.stringify(given));
  const tellPlace = useCallback(() => {
    const place: ViewState = {
      collapsedRows: [...collapsedRows], collapsedColumns: [...collapsedColumns], focusedCell, scroll: scrolled.current,
    };
    const told = JSON.stringify(place);
    if (told === toldPlace.current) return;
    toldPlace.current = told;
    keepViewState(place);
  }, [collapsedRows, collapsedColumns, focusedCell]);
  useEffect(tellPlace, [tellPlace]);
  const [columnWidths, setColumnWidths] = useState<ReadonlyMap<ColumnKey | typeof LABEL_COLUMN, number>>(new Map());
  const resizeColumn = (key: ColumnKey | typeof LABEL_COLUMN, width: number) => setColumnWidths(prev => new Map(prev).set(key, width));
  // One definition of "this column can be written" (ADR-0007; editor.md, Columns, story 4), for the
  // whole grid at once, since per cell it would lag. mEdit refuses every write to a parse-failed record.
  const editableColumns = useMemo(() => columnKeysWhere(result?.overrides, o =>
    copyColumnKey(o) === fileColumn && !immutableSet.has(pluginKeyOf(o)) && trackedSet?.has(pluginKeyOf(o)) === true
      && sourceUnreadableSet?.has(pluginKeyOf(o)) === false
      && o.parseDiagnosis == null),
    [result, fileColumn, immutableSet, trackedSet, sourceUnreadableSet]);

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
    (column: ColumnKey) => (result?.overrides ?? []).find(o => copyColumnKey(o) === column),
    [result]);

  const post = useCallback((plugin: ColumnKey, envelope: RecordEditEnvelope) => {
    const override = overrideFor(plugin);
    if (!override) return;
    editField(override.formKey, override.plugin, override.origin, envelope);
  }, [overrideFor]);

  // An answer lands only if no later read was asked for since: reads answer out of order.
  const latestRead = useRef(0);
  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    const read = ++latestRead.current;
    try {
      const loaded = await client.load(fk);
      if (read !== latestRead.current) return;
      if (!loaded.ok) throw new Error(loaded.error);
      setFormKey(fk);
      setError(null);
      setResult(loaded.result);
      setGone(loaded.result === null);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
      // Unguarded, unlike the two above: a null must replace a previous record's answer, so an
      // unknown state reads as neither tracked nor untracked.
      setTrackedSet(loaded.trackedSet);
      setSourceUnreadableSet(loaded.sourceUnreadableSet);
      // No `?? true` fallback: `undefined` is falsy, so a fixture that omits `conflictsComputed`
      // still shows the banner rather than reading as settled.
      setConflictsComputed(loaded.conflictsComputed);
      setLoadFailures(loaded.loadFailures);
      setFileColumn(loaded.fileColumn);
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

  const loadFailureMessage = recordPanelLoadFailureMessage(loadFailures, result?.overrides ?? []);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
  );
  const rows = useMemo(
    () => result
      ? recordRows({ result, columns, editableColumns, partialFormColumns, recordLabel: copy => recordLabel(result.overrides, copy.formKey) })
      : [],
    [result, columns, editableColumns, partialFormColumns],
  );

  const focused = useMemo<GridCell | ValueCell | undefined>(
    () => focusedCell ? shownCell(rows, collapsedRows, collapsedColumns, focusedCell) : undefined,
    [rows, collapsedRows, collapsedColumns, focusedCell],
  );
  // Told after every render, since a re-read or a move changes what the focused cell's menu would
  // offer without a new focus. Only a user's focus enters the grid.
  const toldFocusedCell = useRef<string | undefined>(undefined);
  useEffect(() => {
    const entered = enteredCell.current;
    enteredCell.current = false;
    const context = focused && editorOpen ? { ...focused.context, editorOpen: true } : focused?.context ?? null;
    const told = JSON.stringify(context);
    if (told === toldFocusedCell.current && !entered) return;
    toldFocusedCell.current = told;
    focusCell(context, entered);
  });

  const pasteIntoFocused = useCallback((text: string) => {
    const plugin = focusedCell?.plugin;
    if (!plugin || !focused || !('editPath' in focused) || !focused.editPath) return;
    handleCellCommit(plugin, focused.editPath, pastedValue(text, focused.meta, focused.shown));
  }, [focusedCell, focused, handleCellCommit]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      let msg;
      try {
        msg = parseExtensionToWebview(event.data);
      } catch {
        return; // Not one of ours, or a stale/mismatched build.
      }
      if (msg.type === EXTENSION_TO_WEBVIEW.LOAD_RECORD) void refresh(msg.formKey);
      if (msg.type === EXTENSION_TO_WEBVIEW.SHOW_COLUMNS) {
        client.showColumns(msg.columns);
        void refresh(formKey);
      }
      if (msg.type === EXTENSION_TO_WEBVIEW.PASTE_INTO_CELL) pasteIntoFocused(msg.text);
      if (msg.type === EXTENSION_TO_WEBVIEW.OPEN_CELL_EDITOR) {
        const cell = scroller.current?.querySelector<HTMLElement>('[data-focused-cell]');
        if (cell) openEditor(cell);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh, pasteIntoFocused, client, formKey]);

  const gridShown = result !== null && !gone;
  const scrollRestored = useRef(false);
  useLayoutEffect(() => {
    const grid = scroller.current;
    if (!grid || scrollRestored.current) return;
    scrollRestored.current = true;
    grid.scrollTop = scrolled.current.top;
    grid.scrollLeft = scrolled.current.left;
  }, [gridShown]);
  useEffect(() => {
    const grid = scroller.current;
    if (!grid) return;
    const keepScroll = () => {
      scrolled.current = { top: grid.scrollTop, left: grid.scrollLeft };
      tellPlace();
    };
    grid.addEventListener('scrollend', keepScroll);
    return () => grid.removeEventListener('scrollend', keepScroll);
  }, [gridShown, tellPlace]);

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
  // Several records compared carry no colours to be final (editor.md, Columns, story 7).
  const severalRecords = overrides.some(o => o.column != null);
  const incompleteMessage = severalRecords ? undefined : recordPanelIncompleteMessage(conflictsComputed);

  function openColumn(opened: CompareOverride) {
    const copyOf = (o: CompareOverride): ColumnCopy => ({ formKey: o.formKey, plugin: pluginAddressOf(o) });
    openInPlace([opened, ...(severalRecords ? overrides.filter(o => o !== opened) : [])].map(copyOf));
  }

  const navColumns = columns.filter(c => !collapsedColumns.has(c.key)).map(c => c.key);

  function handleGridKey(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !focusedCell) return;
    if (editorOpen) return;
    const rowHeight = e.currentTarget.querySelector('tr')?.offsetHeight ?? 0;
    const viewport = (scroller.current?.clientHeight ?? 0) - (headerRow.current?.offsetHeight ?? 0);
    const page = rowHeight > 0 ? Math.max(1, Math.floor(viewport / rowHeight) - 1) : 1;
    const move = navigate(e.key, navRows(rows, collapsedRows), navColumns, focusedCell, page);
    if (!move) return;
    e.preventDefault();
    if ('toggle' in move) toggleRow(move.toggle);
    else handleFocusCell(move.focus.rowKey, move.focus.plugin);
  }

  function renderRow(row: RecordRow) {
    const shared = { key: row.key, columns, collapsedColumns, columnStyle, focusedCell, onFocusCell: handleFocusCell };
    const onToggle = () => toggleRow(row.key);
    switch (row.kind) {
      case 'recordHeader':
        return <RecordHeaderRow {...shared} row={row} expanded={!collapsedRows.has(row.key)} onToggle={onToggle} />;
      case 'formId':
        // The FormID reads each copy's own FormKey, and edits as the FormKey typed.
        return (
          <FormIdRow
            {...shared} row={row} editableColumns={editableColumns}
            onCommitFormId={(plugin, value) => handleCellCommit(plugin, FORM_ID_PATH, value)}
          />
        );
      case 'field':
        return (
          <DiffRow
            {...shared} row={row} isExpanded={!collapsedRows.has(row.key)} onToggle={onToggle}
            onEdit={handleCellCommit} onAddElement={addElement}
          />
        );
    }
  }

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600 }}>
        {`${result.recordTypeName} ${title}`}
      </div>
      {error && <div style={messageStyle}>Showing the last good read: {error}</div>}
      {/* See recordPanelIncompleteMessage. Clears itself with no user action once refresh() next
          lands a settled `conflictsComputed`. */}
      {loadFailureMessage && <div style={messageStyle}>{loadFailureMessage}</div>}
      {incompleteMessage && <div style={messageStyle}>{incompleteMessage}</div>}
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
                // Keyed by col.key (ADR-0012), so two columns that share a file name collapse and
                // resize apart; a status is the plugin's, by its compound key.
                const isImmutable = immutableSet.has(pluginKeyOf(col.override));
                const tracked = trackedSet?.has(pluginKeyOf(col.override)) === true;
                const sourceUnreadable = sourceUnreadableSet?.has(pluginKeyOf(col.override)) === true;
                return (
                  <PluginHeader
                    key={col.key}
                    override={col.override}
                    isImmutable={isImmutable}
                    isTracked={tracked}
                    sourceUnreadable={sourceUnreadable}
                    isFile={col.key === fileColumn}
                    onOpen={() => openColumn(col.override)}
                    collapsed={collapsedColumns.has(col.key)}
                    onToggleCollapse={() => toggleColumnCollapse(col.key)}
                    onResize={width => resizeColumn(col.key, width)}
                    style={{ backgroundColor: headerBackground(col.override.conflictThis), ...columnStyle(col.key) }}
                    // Copy… is offered on every column: copying from a read-only plugin is the
                    // ordinary case.
                    vscodeContext={JSON.stringify(headerCellContext(
                      col.override.formKey, col.override.plugin, col.override.origin, tracked && !sourceUnreadable && !isImmutable,
                    ))}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody onKeyDown={handleGridKey}>
            <EditorMounted.Provider value={editorMounted}>
              {visibleRows(rows, collapsedRows).map(renderRow)}
            </EditorMounted.Provider>
          </tbody>
        </table>
      </div>
    </div>
  );
}
