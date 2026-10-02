import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { ColumnEdge } from './ColumnEdge';
import { DiffRow, type FocusedCell } from './DiffRow';
import {
  buildColumns, columnHasNode,
  wirePath, variantFor, declaresMember,
  headerCellContext, combineVscodeContexts, recordLabel,
} from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, headerCell, getCellStyle, DIMMED_OPACITY, COLLAPSED_COLUMN_WIDTH, columnWidthStyle } from './gridStyles';
import { collapsedSummaries } from './presentation';
import { readsAsFlags } from './modelValue';
import { idleMembers } from './siblingsInUse';
import type {
  ColumnKey, CompareOverride, CompareResult, ConflictThis, FieldDiff, FieldMetadata, PathHop, PluginLoadFailure, RecordEditEnvelope,
} from './types';
import { columnKey, LABEL_COLUMN } from './columnKey';
import { addElement, editField, focusCell, focusedCellContext, logWarning } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, parseExtensionToWebview } from './messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { recordPanelLoadFailureMessage } from './recordPanelLoadFailureMessage';
import { RecordHeaderRow, FormIdRow, RECORD_HEADER_ROW, FORM_ID_ROW, FORM_ID_PATH } from './RecordHeaderRows';
import { navigate, type NavRow } from './gridNavigation';
import { useCellWrites } from './unconfirmedWrites';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey?: string;
};

const headerBg = (c: ConflictThis | null | undefined): string | undefined => getCellStyle(c ?? undefined).backgroundColor;

// ADR-0012: one sweep over the response's own overrides, keyed the way the backend keys its
// dictionaries, so every whole-grid column set is minted the same way.
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

// Two elements sharing a key share a label, and each is a row of its own.
function withRowKeys(parent: string, children: readonly FieldDiff[]): [FieldDiff, string][] {
  const turns = new Map<string, number>();
  return children.map(child => {
    const turn = (turns.get(child.fieldName) ?? 0) + 1;
    turns.set(child.fieldName, turn);
    return [child, turn === 1 ? `${parent}.${child.fieldName}` : `${parent}.${child.fieldName}#${turn}`];
  });
}

const messageStyle: React.CSSProperties = {
  flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-editorWarning-foreground, #cca700)',
  padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)', borderRadius: 2,
};

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [gone, setGone] = useState(false);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0007: null until /plugins answers, and null again when it fails — fail-closed, so a panel
  // that has not heard from /plugins offers no editing, compile or track rather than gestures that
  // cannot land.
  const [trackedSet, setTrackedSet] = useState<Set<ColumnKey> | null>(null);
  // ADR-0013: whether the winner sweep has run. Initial `true` only matters until the first load
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
  // ADR-0018: one source of truth for "which value cell is focused," so at most one cell across
  // the grid is focused at once. Reset on LOAD_RECORD (a different record has no "same cell") but
  // not by refresh().
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
  // Deliberately not reset by LOAD_RECORD: collapse state persists across record navigation.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  const [columnWidths, setColumnWidths] = useState<ReadonlyMap<ColumnKey | typeof LABEL_COLUMN, number>>(new Map());
  const resizeColumn = (key: ColumnKey | typeof LABEL_COLUMN, width: number) => setColumnWidths(prev => new Map(prev).set(key, width));
  // ADR-0007: one definition of "this column can be written", computed for the whole grid at
  // once, since per cell it would lag. The backend refuses every write to a parse-failed record,
  // so a diagnosis vetoes it too.
  const editableColumns = useMemo(() => columnKeysWhere(result?.overrides, (o, key) =>
    !immutableSet.has(key) && trackedSet?.has(key) === true && o.parseDiagnosis == null),
    [result, immutableSet, trackedSet]);

  // editor.md, A column's header: a Partial Form column is dimmed, header and cells alike. One
  // definition of a column's look, so the header and the cells cannot disagree.
  const partialFormColumns = useMemo(() => columnKeysWhere(result?.overrides, o => o.isPartialForm), [result]);
  // editor-fields.md, Partial Form: a Partial Form copy's own fields are read-only.
  const ownFieldColumns = useMemo(
    () => new Set([...editableColumns].filter(key => !partialFormColumns.has(key))), [editableColumns, partialFormColumns]);
  const columnStyle = useCallback((key: ColumnKey | typeof LABEL_COLUMN): React.CSSProperties => ({
    ...(key !== LABEL_COLUMN && partialFormColumns.has(key) ? { opacity: DIMMED_OPACITY } : {}),
    ...columnWidthStyle(key !== LABEL_COLUMN && collapsedColumns.has(key) ? COLLAPSED_COLUMN_WIDTH : columnWidths.get(key)),
  }), [partialFormColumns, collapsedColumns, columnWidths]);

  // ADR-0012: the column key alone is a rendering key; the override carries the compound identity
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
  const { writeAt, written, refused, landed, clear: forgetWrites } = useCellWrites(logWarning);
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
      const unreadable = new Set(loaded.loadFailures.map(f => columnKey(f.name, f.origin)));
      landed(read, loaded.result, fk, column => !unreadable.has(column));
    } catch (e) {
      if (read === latestRead.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, landed]);

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

  useEffect(() => {
    prevFormKeyRef.current = formKey;
    if (!formKey) return;
    if (skipNextRefreshEffect.current) { skipNextRefreshEffect.current = false; return; }
    void refresh(formKey);
  }, [formKey, refresh]);

  function toggleColumnCollapse(key: ColumnKey) {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const fieldMetaMap = useMemo((): Partial<Record<string, FieldMetadata>> => {
    const map: Partial<Record<string, FieldMetadata>> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    return map;
  }, [result]);

  // One leaf, one set: the writer applies whatever a governing member's change idles (ADR-0005).
  const handleCellCommit = useCallback((plugin: ColumnKey, hops: PathHop[], value: unknown) => {
    written(plugin, { op: 'set', path: hops, value }, Infinity);
    post(plugin, { op: 'set', path: hops, value });
  }, [post, written]);

  // Every message here is a broadcast: the extension host has no live reference into this panel's
  // React state, so it says what happened and each open panel decides whether it applies.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      let msg;
      try {
        msg = parseExtensionToWebview(event.data);
      } catch {
        return; // Not one of ours, or a stale/mismatched build.
      }
      if (msg.type === EXTENSION_TO_WEBVIEW.LOAD_RECORD) {
        if (msg.formKey !== prevFormKeyRef.current) {
          // formKey will change → [formKey] effect will fire; skip it.
          skipNextRefreshEffect.current = true;
          setResult(null);
          setGone(false);
          setError(null);
          setFocusedCell(null);
          forgetWrites();
        }
        setFormKey(msg.formKey);
        // Unconditional, not left to the [formKey] effect: a LOAD_RECORD naming the record already
        // open must still re-load (the effect never fires, formKey didn't change) — the
        // skipNextRefreshEffect guard above is what keeps a *changed* formKey from loading twice.
        void refresh(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED) {
        // ADR-0013: a panel already open when the sweep lands must reflect the settled data, not
        // just clear its banner over stale content. Load-order-wide, not record-specific, so no
        // self-filter — every open panel reacts.
        void refresh(prevFormKeyRef.current);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.EDIT_WRITTEN || msg.type === EXTENSION_TO_WEBVIEW.EDIT_REFUSED) {
        const { formKey: edited, plugin, origin, envelope } = msg;
        if (edited !== prevFormKeyRef.current) return;
        const column = columnKey(plugin, origin);
        if (msg.type === EXTENSION_TO_WEBVIEW.EDIT_WRITTEN) written(column, envelope, latestRead.current);
        else refused(column, envelope);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh, written, refused, forgetWrites]);

  const loadFailureMessage = recordPanelLoadFailureMessage(loadFailures, result?.overrides ?? []);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
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
  const { overrides, diffs } = result;

  const title = recordLabel(overrides, formKey);

  const headerExpanded = !collapsedRows.has(RECORD_HEADER_ROW);
  const navRows: NavRow[] = [{ key: RECORD_HEADER_ROW, parent: null, expandable: true, expanded: headerExpanded }];
  const navColumns = columns.filter(c => !collapsedColumns.has(c.key)).map(c => c.key);

  function handleGridKey(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !focusedCell) return;
    if (e.target instanceof Element && e.target.closest('[data-editor]')) return;
    const rowHeight = e.currentTarget.querySelector('tr')?.offsetHeight ?? 0;
    const viewport = (scroller.current?.clientHeight ?? 0) - (headerRow.current?.offsetHeight ?? 0);
    const page = rowHeight > 0 ? Math.max(1, Math.floor(viewport / rowHeight) - 1) : 1;
    const move = navigate(e.key, navRows, navColumns, focusedCell, page);
    if (!move) return;
    e.preventDefault();
    if ('toggle' in move) toggleRow(move.toggle);
    else handleFocusCell(move.focus.rowKey, move.focus.plugin);
  }

  // One recursive builder for every nesting depth — including the recursion a script property's
  // struct members need. `meta` is undefined only for a malformed diff tree; `present` says which
  // columns carry the object this row is a member of.
  function buildRows(
    diff: FieldDiff, meta: FieldMetadata | undefined, path: PathSegment[],
    rootField: string, rowKey: string, parent: string | null, present: (column: ColumnKey) => boolean,
    editable: Set<ColumnKey>, depth = 0,
    collapsedSummary?: Record<string, string>, cellMetas?: Partial<Record<string, FieldMetadata>>,
  ): React.ReactNode[] {
    // A diff node naming a member no override's schema declares has no shape to render against, so
    // it and its subtree are dropped rather than rendered against a guessed one.
    if (!meta) return [];
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = !collapsedRows.has(rowKey);
    navRows.push({ key: rowKey, parent, expandable: hasChildren || readsAsFlags(meta), expanded: isExpanded });

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        diff={diff}
        meta={meta}
        columns={columns}
        columnStyle={columnStyle}
        editableColumns={editable}
        onEditCell={(plugin: ColumnKey, value: unknown) => {
          const hops = wirePath(rootField, path, plugin);
          if (hops) handleCellCommit(plugin, hops, value);
        }}
        writeAt={writeAt}
        onAddElement={addElement}
        collapsedColumns={collapsedColumns}
        recordLabel={title}
        context={{ path, rootField, depth }}
        rowKey={rowKey}
        parentRowKey={parent}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        isExpanded={isExpanded}
        collapsedSummary={collapsedSummary}
        ownerPresent={present}
        cellMetas={cellMetas}
        onToggle={() => toggleRow(rowKey)}
      />,
    ];

    if (!hasChildren || !isExpanded) return rows;

    // Mutagen aliases a condition's parameter slots onto the same bytes, so the idle twin of a
    // live slot would render the same four bytes a second time as a different type. Filtering
    // removes only rows the diff already has.
    const idle = meta.type === 'struct' ? idleMembers(meta, columns.map(c => diff.values[c.key])) : undefined;

    const children = diff.children ?? [];
    for (const [child, childRowKey] of withRowKeys(rowKey, children)) {
      if (idle?.has(child.fieldName)) continue;
      if (meta.type === 'array' && meta.elementType) {
        // The presentation table's unit is one element of a list, and "the last one in this
        // column" is the last child that column carries a value for.
        const collapsedSummary = collapsedSummaries(child, meta.elementType, column =>
          children.filter(c => c.values[column] != null).at(-1) === child);
        // An element is spelled in full, so a column has it exactly where its value is.
        rows.push(...buildRows(
          child, meta.elementType, [...path, { kind: 'element', indexes: child.indexes, keyed: !!meta.keyMembers }],
          rootField, childRowKey, rowKey, column => child.values[column] != null, editable, depth + 1, collapsedSummary));
      } else if (meta.type === 'struct') {
        // A union member's shape is the leaf's the row's own values name; the row takes the first
        // column's leaf for its structure, and each cell the shape its own column's leaf gives it.
        const member = meta.fields?.find(f => f.name === child.fieldName);
        const owner = columns.map(c => diff.values[c.key]).find(v => v != null);
        const memberMeta = member && variantFor(member, owner, meta);
        const cellMetas = member?.variants
          ? Object.fromEntries(columns.map(c => [c.key, variantFor(member, diff.values[c.key], meta)]))
          : undefined;
        rows.push(...buildRows(
          child, memberMeta, [...path, { kind: 'member', name: child.fieldName }],
          rootField, childRowKey, rowKey,
          column => present(column) && columnHasNode(meta, diff.values[column])
            && (!member || declaresMember(member, diff.values[column], meta)),
          editable, depth + 1, undefined, cellMetas));
      }
    }
    return rows;
  }

  // The FormID reads each copy's own FormKey, and edits as the FormKey typed.
  function formIdRow(meta: FieldMetadata) {
    navRows.push({ key: FORM_ID_ROW, parent: RECORD_HEADER_ROW, expandable: false, expanded: false });
    return (
      <FormIdRow
        key={FORM_ID_ROW}
        label={meta.displayLabel ?? meta.name}
        readOnlyReason={meta.readOnlyReason}
        columns={columns}
        collapsedColumns={collapsedColumns}
        columnStyle={columnStyle}
        editableColumns={editableColumns}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        onCommitFormId={(plugin, value) => handleCellCommit(plugin, FORM_ID_PATH, value)}
        writeAt={writeAt}
      />
    );
  }

  const isHeaderMember = (diff: FieldDiff) => fieldMetaMap[diff.fieldName]?.isRecordHeaderMember === true;
  const headerDiffs = diffs.filter(isHeaderMember);
  const headerMemberRows = (diff: FieldDiff): React.ReactNode[] => {
    const meta = fieldMetaMap[diff.fieldName];
    return meta?.isRecordFormKey
      ? [formIdRow(meta)]
      : buildRows(
        diff, meta, [], diff.fieldName, `${RECORD_HEADER_ROW}.${diff.fieldName}`, RECORD_HEADER_ROW, () => true, editableColumns, 1);
  };
  const headerRows = headerExpanded ? headerDiffs.flatMap(headerMemberRows) : [];
  // A Partial Form column's own fields are nulled by the classifier: none is absent by default,
  // since the record's own fields are not there to be members of.
  const fieldRows = diffs.filter(d => !isHeaderMember(d)).flatMap(
    diff => buildRows(
      diff, fieldMetaMap[diff.fieldName], [], diff.fieldName, diff.fieldName, null,
      column => !partialFormColumns.has(column), ownFieldColumns),
  );

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600 }}>
        {`${result.recordTypeName} ${title}`}
      </div>
      {error && <div style={messageStyle}>Showing the last good read: {error}</div>}
      {/* ADR-0017: an unmarked cell here doesn't just omit a badge, it paints a verdict nothing
          has checked yet. Clears itself with no user action once refresh() next lands a settled
          `conflictsComputed`. */}
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
                // ADR-0012: keyed by col.key, never the bare file name, so two columns that share
                // one collapse, resize and read-only apart.
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
                    style={{ backgroundColor: headerBg(col.override.conflictThis), ...columnStyle(col.key) }}
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
            {headerRows}
            {fieldRows}
          </tbody>
        </table>
      </div>
    </div>
  );
}
