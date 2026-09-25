import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { DiffRow, type ArrayOp, type FocusedCell } from './DiffRow';
import {
  buildColumns, columnHasNode, elementSegment, collidingFilenames, rootFieldOf,
  wirePath, variantFor, declaresMember,
  headerCellContext, combineVscodeContexts,
} from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, headerCell, getConflictBg, DIMMED_OPACITY } from './gridStyles';
import { collapsedSummaries } from './presentation';
import { idleMembers } from './siblingsInUse';
import type {
  ColumnKey, CompareOverride, CompareResult, ConflictThis, FieldDiff, FieldMetadata, RecordEditEnvelope,
} from './types';
import { columnKey } from './columnKey';
import { vscode } from './vscode';
import { editField } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, moveEnvelope, parseExtensionToWebview } from './messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { RecordHeaderRows, RECORD_HEADER_ROW } from './RecordHeaderRows';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey?: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

// The document member a record's FormID is, which an edit of the FormID names (editor.md, The
// FormID; edit-record.md).
const FORM_ID_MEMBER = 'FormKey';

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

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0013: a plugin the load order doesn't name drives the header's dimming and tooltip wording
  // independently of the plain immutable fact.
  const [notInLoadOrderSet, setNotInLoadOrderSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0007: starts empty and stays empty until a load says otherwise — fail-closed, so a panel
  // that has not heard from /plugins offers no editing rather than edits that cannot land.
  const [trackedSet, setTrackedSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0013: whether the winner sweep has run. Initial `true` only matters until the first load
  // lands (the `!result` early return renders "Loading…" until then), so it can never read as a
  // false "settled".
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set([RECORD_HEADER_ROW]));
  // ADR-0018: one source of truth for "which value cell is focused," so at most one cell across
  // the grid is focused at once. Reset on LOAD_RECORD (a different record has no "same cell") but
  // not by refresh().
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey) {
    setFocusedCell({ rowKey, plugin });
  }
  // Keyed by column identity — two same-filename columns must collapse independently.
  // Deliberately not reset by LOAD_RECORD: collapse state persists across record navigation.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  // ADR-0007: one definition of "this column can be written", computed for the whole grid at
  // once, since per cell it would lag. The backend refuses every write to a parse-failed record,
  // so a diagnosis vetoes it too.
  const editableColumns = useMemo(() => columnKeysWhere(result?.overrides, (o, key) =>
    !immutableSet.has(key) && !notInLoadOrderSet.has(key) && trackedSet.has(key)
    && !o.isPartialForm && o.parseDiagnosis == null),
    [result, immutableSet, notInLoadOrderSet, trackedSet]);

  // ADR-0013/ADR-0012: one definition of "this column renders at reduced weight" — a plugin the
  // load order does not name, or a Partial Form record — so the header and the cells cannot
  // disagree.
  const dimmedColumns = useMemo(() => columnKeysWhere(result?.overrides, (o, key) =>
    notInLoadOrderSet.has(key) || o.isPartialForm),
    [result, notInLoadOrderSet]);

  // ADR-0012: the column key alone is a rendering key; the override carries the compound identity
  // the write path needs and the values a wire path resolves against.
  const overrideFor = useCallback(
    (plugin: ColumnKey) => (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin),
    [result]);

  // Nothing is applied optimistically — the panel re-reads once the host reports the edit landed.
  // An optimistic patch would show a value the write path had not accepted, which for a refused
  // edit is a lie never corrected.
  const post = useCallback((plugin: ColumnKey, envelope: RecordEditEnvelope) => {
    const override = overrideFor(plugin);
    if (!override) return;
    editField(formKey, override.plugin, override.origin, envelope);
  }, [overrideFor, formKey]);

  // The hops from the record's own member down to the row, resolved against this column's value
  // where a hop needs the document (an element of a sorted array).
  const hopsTo = useCallback((plugin: ColumnKey, rootField: string, path: PathSegment[]) =>
    wirePath(rootField, path, rootFieldOf(overrideFor(plugin), rootField)?.value),
    [overrideFor]);

  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    try {
      setError(null);
      const loaded = await client.load(fk);
      if (!loaded.ok) throw new Error(loaded.error);
      setResult(loaded.result);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
      if (loaded.notInLoadOrderSet) setNotInLoadOrderSet(loaded.notInLoadOrderSet);
      // `??`, not a truthiness guard like the two above — this one has to degrade to "nothing is
      // editable", so a null must actively clear the set rather than leave a previous record's
      // answer standing.
      setTrackedSet(loaded.trackedSet ?? new Set());
      // No `?? true` fallback: `undefined` is falsy, so a fixture that omits `conflictsComputed`
      // still shows the banner rather than reading as settled.
      setConflictsComputed(loaded.conflictsComputed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

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

  function handleOpen(fk: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: fk });
  }

  function toggleColumnCollapse(key: ColumnKey) {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // The header record's synthetic FormKey is "000000:<plugin>". Computed ahead of every hook that
  // needs it, since hooks can't follow the early-return guards below.
  const isHeaderRecord = formKey.startsWith('000000:');

  const fieldMetaMap = useMemo((): Partial<Record<string, FieldMetadata>> => {
    const map: Partial<Record<string, FieldMetadata>> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    // ADR-0008: the header record's masters field displays but is never directly editable —
    // stamped readOnly here rather than gated a second way, so every consumer sees one answer.
    const mastersMeta = map.MasterReferences;
    if (isHeaderRecord && mastersMeta) {
      map.MasterReferences = {
        ...mastersMeta, readOnly: true,
        elementType: mastersMeta.elementType ? { ...mastersMeta.elementType, readOnly: true } : mastersMeta.elementType,
      };
    }
    return map;
  }, [result, isHeaderRecord]);

  // `path` addresses the array itself for add and the element for the rest. A move off either end
  // is the backend's to refuse by name, so the direction the row asked for is posted as it is.
  const handleArrayOp = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string, op: ArrayOp,
  ) => {
    const hops = hopsTo(plugin, rootField, path);
    if (op === 'add' || op === 'remove') { post(plugin, { op, path: hops }); return; }
    const envelope = moveEnvelope(hops, op === 'moveUp' ? -1 : 1);
    if (envelope) post(plugin, envelope);
  }, [post, hopsTo]);

  // One leaf, one set: the writer applies whatever a governing member's change idles (ADR-0005).
  const handleCellCommit = useCallback((plugin: ColumnKey, path: PathSegment[], rootField: string, value: unknown) => {
    post(plugin, { op: 'set', path: hopsTo(plugin, rootField, path), value });
  }, [post, hopsTo]);

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
        }
        setFormKey(msg.formKey);
        setResult(null);
        setError(null);
        setFocusedCell(null);
        // Unconditional, not left to the [formKey] effect: a LOAD_RECORD naming the record already
        // open must still re-load (the effect never fires, formKey didn't change) — the
        // skipNextRefreshEffect guard above is what keeps a *changed* formKey from loading twice.
        void refresh(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED) {
        // ADR-0013: a panel already open when the sweep lands must reflect the settled data, not
        // just clear its banner over stale content. Load-order-wide, not record-specific, so no
        // self-filter — every open panel reacts.
        void refresh(prevFormKeyRef.current);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh]);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
  );

  // ADR-0012: origin appears inline in the header only when two plugins share a filename —
  // computed from this response's own overrides, never the load order's plugin list.
  const collidingPluginNames = useMemo(
    () => collidingFilenames(result?.overrides ?? []),
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

  if (!formKey) return <div style={containerStyle}>No record selected.</div>;
  if (error) return <div style={{ ...containerStyle, color: 'var(--vscode-errorForeground, #f44)' }}>Error: {error}</div>;
  if (!result) return <div style={containerStyle}>Loading…</div>;

  // `result.conflictAll` is record-wide and deliberately not threaded into the row background —
  // that is each row's own `diff.conflictAll`, computed bottom-up per node.
  const { overrides, diffs } = result;

  const winner = overrides.find(o => o.isWinner);
  const displayId = (winner ?? overrides.at(0))?.editorId;
  const title = displayId ? `${displayId} [${formKey}]` : formKey;

  // One recursive builder for every nesting depth — including the recursion a script property's
  // struct members need. `meta` is undefined only for a malformed diff tree; `present` says which
  // columns carry the object this row is a member of.
  function buildRows(
    diff: FieldDiff, meta: FieldMetadata | undefined, path: PathSegment[],
    rootField: string, rowKey: string, present: (column: ColumnKey) => boolean, depth = 0,
    collapsedSummary?: Record<string, string>, cellMetas?: Partial<Record<string, FieldMetadata>>,
  ): React.ReactNode[] {
    // A diff node naming a member no override's schema declares has no shape to render against, so
    // it and its subtree are dropped rather than rendered against a guessed one.
    if (!meta) return [];
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = expandedStructs.has(rowKey);

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        diff={diff}
        meta={meta}
        columns={columns}
        dimmedColumns={dimmedColumns}
        editableColumns={editableColumns}
        onEditCell={(plugin: ColumnKey, value: unknown) => handleCellCommit(plugin, path, rootField, value)}
        onArrayOp={(plugin: ColumnKey, op: ArrayOp) => handleArrayOp(plugin, path, rootField, op)}
        collapsedColumns={collapsedColumns}
        onOpen={handleOpen}
        recordLabel={title}
        context={{ path, rootField, depth }}
        rowKey={rowKey}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        isExpanded={isExpanded}
        collapsedSummary={collapsedSummary}
        ownerPresent={present}
        cellMetas={cellMetas}
        onToggle={() => setExpandedStructs(prev => {
          const next = new Set(prev);
          if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
          return next;
        })}
      />,
    ];

    if (!hasChildren || !isExpanded) return rows;

    // Mutagen aliases a condition's parameter slots onto the same bytes, so the idle twin of a
    // live slot would render the same four bytes a second time as a different type. Filtering
    // removes only rows the diff already has.
    const idle = meta.type === 'struct' ? idleMembers(meta, columns.map(c => diff.values[c.key])) : undefined;

    const children = diff.children ?? [];
    for (const [ordinal, child] of children.entries()) {
      if (idle?.has(child.fieldName)) continue;
      const childRowKey = `${rowKey}.${child.fieldName}`;
      if (meta.type === 'array' && meta.elementType) {
        // The presentation table's unit is one element of a list, and "the last one in this
        // column" is the last child that column carries a value for.
        const collapsedSummary = collapsedSummaries(child, meta.elementType, column =>
          children.filter(c => c.values[column] != null).at(-1) === child);
        // An element is spelled in full, so a column has it exactly where its value is.
        rows.push(...buildRows(
          child, meta.elementType, [...path, elementSegment(meta, child.fieldName, ordinal)],
          rootField, childRowKey, column => child.values[column] != null, depth + 1, collapsedSummary));
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
          rootField, childRowKey,
          column => present(column) && columnHasNode(meta, diff.values[column])
            && (!member || declaresMember(member, diff.values[column], meta)),
          depth + 1, undefined, cellMetas));
      }
    }
    return rows;
  }

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
      {/* ADR-0017: an unmarked cell here doesn't just omit a badge, it paints a verdict nothing
          has checked yet. Clears itself with no user action once refresh() next lands a settled
          `conflictsComputed`. */}
      {recordPanelIncompleteMessage(conflictsComputed) && (
        <div style={{ flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-editorWarning-foreground, #cca700)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)', borderRadius: 2 }}>
          {recordPanelIncompleteMessage(conflictsComputed)}
        </div>
      )}
      {/* flex:1 + minHeight:0 lets this wrapper shrink to the remaining viewport space (the
          flex-item default of min-height:auto would defeat that). overflow:auto then keeps the
          horizontal scrollbar reachable at any scroll position. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...headerCell, textAlign: 'left', minWidth: '160px' }}>Field</th>
              {columns.map(col => {
                {
                  // ADR-0012: keyed by col.key (ColumnKey), not the bare plugin filename — two
                  // same-filename columns must collapse and read-only independently. The header
                  // context still gets the real plugin+origin pair, never the compound key.
                  const isCollapsed = collapsedColumns.has(col.key);
                  const isImmutable = immutableSet.has(col.key);
                  // ADR-0013: the column's own load-order membership drives both the header's
                  // reason wording and the dimming that carries down through every cell in this
                  // column — "non-participating plugins render dimmed".
                  const inLoadOrder = !notInLoadOrderSet.has(col.key);
                  return (
                    <th
                      key={col.key}
                      style={{
                        ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px',
                        backgroundColor: getHeaderBg(col.override.conflictThis),
                        opacity: dimmedColumns.has(col.key) ? DIMMED_OPACITY : undefined,
                      }}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={isImmutable}
                        inLoadOrder={inLoadOrder}
                        isTracked={trackedSet.has(col.key)}
                        showOriginInline={collidingPluginNames.has(col.override.plugin)}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.key)}
                        // Copy as Override Into…/Copy as New Record Into…,
                        // this column's native right-click menu — unconditional on isImmutable/
                        // isTracked/inLoadOrder, since copying *from* any of those is the ordinary
                        // case, not one to gate out.
                        vscodeContext={combineVscodeContexts(
                          headerCellContext(col.override.formKey, col.override.plugin, col.override.origin),
                        )}
                        // The annotated synthetic member is the one sanctioned header-flag write —
                        // exempt from the backend's Partial Form read-only guard, so it lands
                        // regardless of the column's current state.
                        onTogglePartialForm={next => post(col.key, {
                          op: 'set', path: [{ kind: 'member', name: 'IsPartialForm' }], value: next,
                        })}
                      />
                    </th>
                  );
                }
              })}
            </tr>
          </thead>
          <tbody>
            {/* A Partial Form column's own fields are nulled by the classifier: none is absent by
                default, since the record's own fields are not there to be members of. */}
            <RecordHeaderRows
              columns={columns}
              collapsedColumns={collapsedColumns}
              dimmedColumns={dimmedColumns}
              editableColumns={editableColumns}
              isPluginHeader={isHeaderRecord}
              expanded={expandedStructs.has(RECORD_HEADER_ROW)}
              onToggle={() => setExpandedStructs(prev => {
                const next = new Set(prev);
                if (next.has(RECORD_HEADER_ROW)) next.delete(RECORD_HEADER_ROW); else next.add(RECORD_HEADER_ROW);
                return next;
              })}
              focusedCell={focusedCell}
              onFocusCell={handleFocusCell}
              onCommitFormId={(plugin, value) => post(plugin, { op: 'set', path: [{ kind: 'member', name: FORM_ID_MEMBER }], value })}
            />
            {diffs.flatMap(
              diff => buildRows(
                diff, fieldMetaMap[diff.fieldName], [], diff.fieldName, diff.fieldName,
                column => !overrideFor(column)?.isPartialForm),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
