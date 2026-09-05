import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { DiffRow, type FocusedCell } from './DiffRow';
import {
  buildColumns, elementSegment, collidingFilenames,
  isArrayElementHop, isMovableElementHop, offersArrayAdd,
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
import { columnKey } from './types';
import { vscode } from './vscode';
import { editField, openExtendedFieldEditor } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from '../../src/medit/loadOrderProgress';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey?: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

type ArrayOpKind = 'add' | 'remove' | 'moveUp' | 'moveDown';


// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0035: a copy the load order doesn't name drives the header's dimming and tooltip wording
  // independently of the plain immutable fact.
  const [notInLoadOrderSet, setNotInLoadOrderSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0041: starts empty and stays empty until a load says otherwise — fail-closed, so a panel
  // that has not heard from /plugins offers no editing rather than edits that cannot land.
  const [trackedSet, setTrackedSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0035: whether the winner sweep has run. Initial `true` only matters until the first load
  // lands (the `!result` early return renders "Loading…" until then), so it can never read as a
  // false "settled".
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // ADR-0034: one source of truth for "which value cell is focused," so at most one cell across
  // the grid is focused at once. Reset on LOAD_RECORD (a different record has no "same cell") but
  // not by refresh().
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey) {
    setFocusedCell({ rowKey, plugin });
  }
  // Keyed by column identity — two same-filename columns must collapse independently.
  // Deliberately not reset by LOAD_RECORD: collapse state persists across record navigation.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  // ADR-0041: one definition of "this column can be written", computed once for the whole grid.
  // Derived rather than asked of the backend per cell — a per-cell round trip would make
  // editability lag the grid it decorates.
  const editableColumns = useMemo(() => {
    const writable = new Set<ColumnKey>();
    for (const o of result?.overrides ?? []) {
      const key = columnKey(o.plugin, o.origin);
      if (!immutableSet.has(key) && !notInLoadOrderSet.has(key) && trackedSet.has(key) && !o.isPartialForm) {
        writable.add(key);
      }
    }
    return writable;
  }, [result, immutableSet, notInLoadOrderSet, trackedSet]);

  // Nothing is applied optimistically — the panel re-reads once the host reports the edit landed.
  // An optimistic patch would show a value the write path had not accepted, which for a refused
  // edit is a lie never corrected.
  const post = useCallback((plugin: ColumnKey, envelope: RecordEditEnvelope) => {
    // The override carries the compound identity the write path needs; the column key alone is a
    // rendering key, not something the backend can resolve (ADR-0036).
    const override = (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin);
    if (!override) return;
    editField(formKey, override.plugin, override.origin, envelope);
  }, [result, formKey]);

  // The hops from the record's own member down to the row, resolved against this column's value
  // where a hop needs the document (an element of a sorted array).
  const hopsTo = useCallback((plugin: ColumnKey, rootField: string, path: PathSegment[]) => {
    const rootDiff = (result?.diffs ?? []).find(d => d.fieldName === rootField);
    return wirePath(rootField, path, rootDiff?.values[plugin]);
  }, [result]);

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
    // ADR-0038: the header record's masters field displays but is never directly editable —
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

  // `path` addresses the array for add and the element for the rest; a move's value is the
  // position the element goes to. The backend resolves each against the document it holds.
  const handleArrayOp = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string, op: ArrayOpKind,
  ) => {
    const hops = hopsTo(plugin, rootField, path);
    const last = hops[hops.length - 1];
    if (op === 'add') post(plugin, { op: 'add', path: hops });
    else if (op === 'remove') post(plugin, { op: 'remove', path: hops });
    else if (last.kind === 'index') post(plugin, { op: 'move', path: hops, value: last.index + (op === 'moveUp' ? -1 : 1) });
  }, [post, hopsTo]);

  // One leaf, one set: the writer applies whatever a governing member's change idles (ADR-0032).
  const handleCellCommit = useCallback((plugin: ColumnKey, path: PathSegment[], rootField: string, value: unknown) => {
    post(plugin, { op: 'set', path: hopsTo(plugin, rootField, path), value });
  }, [post, hopsTo]);

  // ADR-0039: a string cell's value in a real editor tab, reached only from the cell's right-click
  // menu. Its save is the same leaf commit as the inline editor's.
  const handleOpenExtended = useCallback((
    plugin: ColumnKey, fieldName: string, path: PathSegment[], rootField: string, value: string, readOnly: boolean,
  ) => {
    const override = (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin);
    if (!override) return;
    // The composite label — the same "EditorID [FormKey]" string the FormKey picker
    // seeds with and the header displays, so the tab's directory names the record the same way
    // every other identity-bearing surface here already does.
    const displayId = (result?.overrides.find(o => o.isWinner) ?? result?.overrides[0])?.editorId;
    const recordLabel = displayId ? `${displayId} [${formKey}]` : formKey;
    openExtendedFieldEditor(
      { value, recordLabel, fieldName, plugin: override.plugin, origin: override.origin, readOnly },
      (v: string) => handleCellCommit(plugin, path, rootField, v),
    );
  }, [result, formKey, handleCellCommit]);

  // The broadcast-and-self-filter shape: the extension host has no live reference into this
  // panel's React state, which alone holds the record's current values. Depends on the handlers it
  // calls, so it re-subscribes when they change.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebview;
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
      } else if (msg.type === EXTENSION_TO_WEBVIEW.RECORD_EDITED) {
        // The edit landed as a working-tree change. Re-read rather than patch: the write
        // path re-serialized the record through the codec, and this record's conflict picture
        // across every other column may have moved with it.
        if (msg.formKey === prevFormKeyRef.current) void refresh(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED) {
        // ADR-0035: a panel already open when the sweep lands must reflect the settled data, not
        // just clear its banner over stale content. Load-order-wide, not record-specific, so no
        // self-filter — every open panel reacts.
        void refresh(prevFormKeyRef.current);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP) {
        // Self-filter on formKey — a changeId-less broadcast (there is no per-change id here).
        // Only reachable while this exact record is open, so a
        // stale/background panel showing a different record ignores it.
        if (msg.formKey !== prevFormKeyRef.current) return;
        const plugin = columnKey(msg.plugin, msg.origin);
        handleArrayOp(plugin, msg.path, msg.rootField, msg.op);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR) {
        // ADR-0039: the string-cell right-click command's own broadcast — self-filter on
        // formKey, same convention as every other right-click op above, then hand off to the
        // bridge call.
        if (msg.formKey !== prevFormKeyRef.current) return;
        handleOpenExtended(
          columnKey(msg.plugin, msg.origin), msg.fieldName, msg.path, msg.rootField, msg.value, msg.readOnly,
        );
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refresh, handleArrayOp, handleOpenExtended]);

  // ADR-0036: keyed by ColumnKey, not the bare plugin filename — two overrides sharing a filename
  // would otherwise collide, the second silently discarding the first. Declared Record<string, …>
  // since the brand is erased on a dictionary regardless.
  const overrideMap = useMemo((): Partial<Record<string, CompareOverride>> => {
    const map: Partial<Record<string, CompareOverride>> = {};
    for (const o of result?.overrides ?? []) map[columnKey(o.plugin, o.origin)] = o;
    return map;
  }, [result]);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
  );

  // ADR-0036: origin appears inline in the header only when two copies share a filename —
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
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = expandedStructs.has(rowKey);
    // A row's own last hop says what it is and which gestures it offers — the same question
    // DiffRow's own cell menu and the native one both ask, of the same path (recordUtils.ts).
    const elementHop = path.at(-1);

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        diff={diff}
        columns={columns}
        overrideMap={overrideMap}
        fieldMetaMap={fieldMetaMap}
        notInLoadOrderSet={notInLoadOrderSet}
        editableColumns={editableColumns}
        onEditCell={(plugin: ColumnKey, value: unknown) => handleCellCommit(plugin, path, rootField, value)}
        onArrayAdd={offersArrayAdd(meta) ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'add') : undefined}
        onArrayRemove={isArrayElementHop(elementHop) ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'remove') : undefined}
        onArrayMoveUp={isMovableElementHop(elementHop) ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveUp') : undefined}
        onArrayMoveDown={isMovableElementHop(elementHop) ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveDown') : undefined}
        collapsedColumns={collapsedColumns}
        onOpen={handleOpen}
        context={{ path, overrideMeta: meta, rootField, depth }}
        rowKey={rowKey}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        hasChildren={hasChildren}
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

    if (!hasChildren || !isExpanded || !meta) return rows;

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
          column => present(column) && diff.values[column] != null && (!member || declaresMember(member, diff.values[column], meta)),
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
      {/* ADR-0035: an unmarked cell here doesn't just omit a badge, it paints a verdict nothing
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
                  // ADR-0036: keyed by col.key (ColumnKey), not the bare plugin filename — two
                  // same-filename columns must collapse and read-only independently. The header
                  // context still gets the real plugin+origin pair, never the compound key.
                  const isCollapsed = collapsedColumns.has(col.key);
                  const isImmutable = immutableSet.has(col.key);
                  // ADR-0035: the column's own load-order membership drives both the header's
                  // reason wording and the dimming that carries down through every cell in this
                  // column — "non-participating copies render dimmed".
                  const inLoadOrder = !notInLoadOrderSet.has(col.key);
                  // A Partial Form column dims the same way a not-in-load-order one does —
                  // xEdit's own answer ("shown as such, not as a full competing override") applied
                  // to a never-hide-data posture.
                  const dimmed = !inLoadOrder || col.override.isPartialForm;
                  return (
                    <th
                      key={`disk:${col.key}`}
                      style={{
                        ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px',
                        backgroundColor: getHeaderBg(col.override.conflictThis),
                        opacity: dimmed ? DIMMED_OPACITY : undefined,
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
            {diffs.flatMap(
              diff => buildRows(
                diff, fieldMetaMap[diff.fieldName], [], diff.fieldName, diff.fieldName,
                column => !overrideMap[column]?.isPartialForm),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
