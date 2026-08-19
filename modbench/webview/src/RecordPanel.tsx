import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { DiffRow, type FocusedCell } from './DiffRow';
import { buildColumns, parseElementIndex, collidingFilenames } from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, headerCell, getConflictBg, DIMMED_OPACITY } from './gridStyles';
import { buildVmadRows } from './vmadTreeAdapter';
import { buildConditionRows } from './conditionTreeAdapter';
import type { ColumnKey, CompareOverride, CompareResult, ConflictThis, FieldDiff, FieldMetadata } from './types';
import { columnKey } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';
import type { RecordSessionClient } from './RecordSessionClient';
import { recordPanelIncompleteMessage } from '../../src/medit/sessionProgress';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

// Issue #231: a synthesized row can restage independently of its own parent rather than
// extending it — a VMAD property under its script container, or a Condition field under its
// condition element, each stage their own atomic PendingChange rather than folding into the
// whole subtree their parent restages (ADR-0017's usual rule). `FieldDiff.wirePath` is the
// signal: when a child carries one, it starts a fresh subtree right there (its own path resets to
// `[]`, rootField becomes its own wirePath, rootDiff becomes itself) instead of inheriting the
// parent's. An ordinary reflected field's children never carry `wirePath` (only the VMAD/
// Condition tree adapters set it), so this is a no-op for every pre-#231 case — never true, never
// taken, and the recursion behaves exactly as it did in slice 0. Module-scope (not a RecordPanel-
// local closure like buildRows/buildArrayElementRows below) since it closes over nothing.
function subtreeFor(
  child: FieldDiff, seg: PathSegment, path: PathSegment[], rootField: string, rootDiff: FieldDiff,
): { path: PathSegment[]; rootField: string; rootDiff: FieldDiff } {
  if (child.wirePath !== undefined) return { path: [], rootField: child.wirePath, rootDiff: child };
  return { path: [...path, seg], rootField, rootDiff };
}

// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordSessionClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  // Issue #167: the Run On target dropdown's catalog (GET /condition-run-on-targets) — a
  // session-wide list, not per-record, so it's fetched once on mount rather than on every
  // refresh()/load(fk). Starts empty (the Run On cell simply has nothing to show until this
  // resolves) rather than falling back to any hardcoded list. No `.catch` needed here:
  // client.conditionRunOnTargets() never rejects — it logs and degrades to [] on both a non-ok
  // response and a thrown network error itself (RecordSessionClient.ts), the same contract
  // PluginRepository.getConditionFunctions() gives its own callers.
  const [runOnTargets, setRunOnTargets] = useState<string[]>([]);
  useEffect(() => { void client.conditionRunOnTargets().then(setRunOnTargets); }, [client]);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // #304 / ADR-0035: mirrors immutableSet's own state shape — a copy the load order doesn't name
  // (distinct from "is immutable"; see recordUtils.ts's readOnlyReason) drives PluginHeader's
  // dimming/tooltip wording independently of the plain immutable fact.
  const [notInLoadOrderSet, setNotInLoadOrderSet] = useState<Set<ColumnKey>>(new Set());
  // #308 / ADR-0035: whether the winner sweep has run — GET /session/status's own field, read by
  // client.load() alongside compare/changes/plugins. Initial `true` only matters until the first
  // load lands (the `!result` early-return below renders "Loading…" until then, so this can never
  // read as a false "settled" to the user); every value after that comes straight off the load's
  // own `conflictsComputed`, which is a required field precisely so there is no silent fallback
  // here that could paper over a status fetch nobody checked.
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // Issue #222 / ADR-0034: the single source of truth for "which value cell is focused," shared
  // by every DiffRow instance so at most one cell across the field grid is ever focused at once —
  // DiffRow itself only knows about its own row. `rowKey` matches the string this component
  // already computes for each DiffRow's own `key=` below. Deliberately reset on LOAD_RECORD (a
  // different record has no "same cell" to keep focused — mirrors the result/allChanges resets
  // there) but left untouched by refresh() (same-record reload from staging or a background
  // refresh, where the focused cell should survive — AC3). Issue #232: covers a pending-column
  // cell too now, disambiguated from its same-plugin disk companion by FocusedCell's own
  // `column` discriminant — handleFocusCell just forwards whatever DiffRow passes.
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey, column?: 'pending') {
    setFocusedCell({ rowKey, plugin, column });
  }
  // Issue #3: collapsed plugin columns, keyed by column identity (#272: ColumnKey, not the bare
  // plugin name — two same-filename columns must collapse independently). Deliberately NOT reset
  // by the LOAD_RECORD handler below — collapse state is meant to persist across record-to-record
  // navigation within the same panel session.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  // Issue #3: transient drag payload — doesn't need to trigger a re-render, so a ref rather
  // than state. Cleared on drop (successful or rejected). Issue #206: carries sourcePlugin too —
  // without it, handleCellDrop has no way to tell a drop back onto the same cell it came from
  // apart from a real cross-column copy. #272: sourcePlugin is a ColumnKey.

  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    try {
      setError(null);
      const loaded = await client.load(fk);
      if (!loaded.ok) throw new Error(loaded.error);
      setResult(loaded.result);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
      if (loaded.notInLoadOrderSet) setNotInLoadOrderSet(loaded.notInLoadOrderSet);
      // #308: no `?? true` fallback. Against a real client, `conflictsComputed` is required on
      // LoadResult (RecordSessionClient.ts), so a genuine response omitting it fails to compile.
      // That guarantee does *not* reach this webview's own test fixtures — RecordPanel.test.tsx's
      // fakeClient builds its LoadResult as `as unknown as LoadResult`, which bypasses structural
      // checking entirely, so a fixture that forgot this field would compile fine and read
      // `undefined` here at runtime. What actually protects that path is this line's own
      // fail-closed reading: `undefined` is falsy, so recordPanelIncompleteMessage below still
      // shows the banner rather than silently reading as settled — the type system is not what's
      // doing the catching there.
      setConflictsComputed(loaded.conflictsComputed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  const refreshRef = useRef(refresh);
  useLayoutEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

  // Listen for loadRecord messages from the extension (panel reuse) and for the session's own
  // conflicts-computed signal. #410/ADR-0041: every other branch this handler used to carry was a
  // native edit command broadcasting into this panel — those commands and their endpoints are gone.
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
      } else if (msg.type === EXTENSION_TO_WEBVIEW.SESSION_CONFLICTS_COMPUTED) {
        // #308 / ADR-0035 AC4: a panel already open when the sweep lands must reflect the settled
        // data, not just clear its own banner over stale content — refresh() re-runs client.load()
        // in full, so the grid and the banner update together in one state change. Session-wide,
        // not record-specific, so no self-filter — every open panel reacts.
        void refreshRef.current(prevFormKeyRef.current);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    prevFormKeyRef.current = formKey;
    if (!formKey) return;
    if (skipNextRefreshEffect.current) { skipNextRefreshEffect.current = false; return; }
    void refreshRef.current(formKey);
  }, [formKey]);

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

  // Issue #86/#119: the header record (synthetic FormKey "000000:<plugin>") carries neither VMAD
  // nor Conditions — same gate the deleted VmadSection/ConditionSection call sites used
  // (`!isHeaderRecord`), computed here (ahead of every hook that needs it, including
  // fieldMetaMap's masters-readOnly stamp below) since hooks can't follow the early-return guards
  // that precede where the rest of the render logic would naturally compute this.
  const isHeaderRecord = formKey.startsWith('000000:');

  // Issue #231: VMAD and Conditions map into the same node shape (FieldDiff + FieldMetadata) the
  // ordinary reflected fields already use — vmadTreeAdapter.ts/conditionTreeAdapter.ts are pure
  // functions with no rendering of their own, so their rows flow through the exact same
  // buildRows/DiffRow path below as any other field, and there is no VmadSection/ConditionSection
  // left to render separately.
  const vmadTree = useMemo(
    () => (isHeaderRecord || !result?.hasVmad) ? { diffs: [], metaMap: {} } : buildVmadRows(result.vmad),
    [result, isHeaderRecord],
  );
  const conditionTree = useMemo(
    () => isHeaderRecord ? { diffs: [], metaMap: {} } : buildConditionRows(result?.conditions, runOnTargets),
    [result, isHeaderRecord, runOnTargets],
  );

  const fieldMetaMap = useMemo((): Record<string, FieldMetadata> => {
    const map: Record<string, FieldMetadata> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    Object.assign(map, vmadTree.metaMap, conditionTree.metaMap);
    // #335/ADR-0038: the header record's masters field displays but is never directly editable —
    // stamped readOnly here (the same per-row override DiffRow already honors for the Condition
    // AND/OR gate and VMAD's synthesized Flags row) rather than gated a second way, so every
    // consumer of this map — the array-parent "Add" affordance and each element's own Remove/Move
    // Up/Move Down, both otherwise wired generically for any array field — sees exactly one
    // answer. Stamped on the element type too: array-op availability for an *element* row is
    // computed from that row's own meta (the element schema), not the parent's.
    const mastersMeta = map.masters;
    if (isHeaderRecord && mastersMeta) {
      map.masters = {
        ...mastersMeta, readOnly: true,
        elementType: mastersMeta.elementType ? { ...mastersMeta.elementType, readOnly: true } : mastersMeta.elementType,
      };
    }
    return map;
  }, [result, vmadTree, conditionTree, isHeaderRecord]);

  // #272 / ADR-0036: keyed by ColumnKey, not the bare plugin filename — pre-#272, two overrides
  // sharing a filename but differing in origin collided here, and the second silently discarded
  // the first (this is the concrete data-loss bug named in the plan). Every consumer of this map
  // (Copy as New Record's field source, Add Master's current-masters read, array/VMAD op
  // resolution, DiffRow's own render loop) reads it by ColumnKey now. Declared as
  // Record<string, ...> rather than Record<ColumnKey, ...> — a mapped type over a non-literal
  // string collapses to a plain index signature either way (ColumnKey's brand is erased on a
  // dictionary regardless, see types.ts' own doc comment), so this loses no real protection and
  // keeps the React Compiler's manual-memoization check happy (it couldn't preserve the
  // ColumnKey-typed version's memoization).
  const overrideMap = useMemo((): Record<string, CompareOverride> => {
    const map: Record<string, CompareOverride> = {};
    for (const o of result?.overrides ?? []) map[columnKey(o.plugin, o.origin)] = o;
    return map;
  }, [result]);

  const columns = useMemo(
    () => result ? buildColumns(result.overrides) : [],
    [result],
  );

  // #304 / ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — computed from this response's own overrides (never the session's whole plugin
  // list), same source columns already comes from.
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

  // Issue #114: `result.conflictAll` (record-wide) is no longer threaded into the compare grid's
  // row background — that's now each row's own `diff.conflictAll` (DiffRow), computed bottom-up
  // per node. The record-wide value remains the Plugins-tree's own record badge, sourced there
  // independently — this component has no use for it any more.
  const { overrides, diffs } = result;

  const winner = overrides.find(o => o.isWinner);
  const displayId = (winner ?? overrides[0])?.editorId;
  const title = displayId ? `${displayId} [${formKey}]` : formKey;

  // Issue #231: replaces the old hand-built top-level/array-element/struct-child/grandchild
  // special-casing (three near-duplicate `<DiffRow>` blocks, capped at exactly those three
  // levels) with one recursive builder — the same recursion VMAD's own struct data has always
  // needed (Schema/VmadCodec.cs: "the (de)serializer descends to arbitrary depth") and which
  // folding VMAD into this one tree requires generalizing to, rather than bolting a second,
  // VMAD-only deep path alongside this one. `path`/`rootField` are RowContext's own fields
  // (DiffRow.tsx) — every row in one subtree stages through the same rootField, and getAtPath/
  // setAtPath (recordUtils.ts) are the one generic read/write every depth shares.
  //
  // `meta` is this node's own resolved FieldMetadata (undefined only for a malformed diff tree —
  // DiffRow's own `context.overrideMeta`-driven null-return handles that at render time, exactly
  // as it always has); `rootDiff` is the top of this subtree (its `values` are what
  // currentRootValue reads the disk fallback from); `arrayEdit` is supplied by the *parent* call
  // when this row is itself an unsorted array's element — never computed by a row for itself.
  function buildRows(
    diff: FieldDiff, meta: FieldMetadata | undefined, path: PathSegment[],
    rootField: string, rootDiff: FieldDiff, rowKey: string,
  ): React.ReactNode[] {
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = expandedStructs.has(rowKey);

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        diff={diff}
        columns={columns}
        overrideMap={overrideMap}
        fieldMetaMap={fieldMetaMap}
        notInLoadOrderSet={notInLoadOrderSet}
        collapsedColumns={collapsedColumns}
        onOpen={handleOpen}
        context={{ path, overrideMeta: meta, rootField }}
        rowKey={rowKey}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onToggle={() => setExpandedStructs(prev => {
          const next = new Set(prev);
          if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
          return next;
        })}
      />,
    ];

    if (!hasChildren || !isExpanded || !meta) return rows;

    for (const child of diff.children ?? []) {
      const childRowKey = `${rowKey}.${child.fieldName}`;
      if (meta.type === 'array' && meta.elementType) {
        rows.push(...buildArrayElementRows(child, meta.elementType, path, rootField, rootDiff, childRowKey));
      } else if (meta.type === 'struct') {
        const memberMeta = meta.fields?.find(f => f.name === child.fieldName);
        const sub = subtreeFor(child, { kind: 'member', name: child.fieldName }, path, rootField, rootDiff);
        rows.push(...buildRows(child, memberMeta, sub.path, sub.rootField, sub.rootDiff, childRowKey));
      }
    }
    return rows;
  }

  function buildArrayElementRows(
    child: FieldDiff, elementMeta: FieldMetadata, arrayPath: PathSegment[], rootField: string, rootDiff: FieldDiff,
    childRowKey: string,
  ): React.ReactNode[] {
    const seg: PathSegment = elementMeta.isSortable
      ? { kind: 'sortKey', key: child.fieldName }
      : { kind: 'index', index: parseElementIndex(child.fieldName) };
    return buildRows(child, elementMeta, [...arrayPath, seg], rootField, rootDiff, childRowKey);
  }

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
      {/* #308 / ADR-0035: the record editor's own "an absent conflict badge must never be
          mistakable for 'no conflict'" statement — this surface renders conflict colouring
          today (unlike the Plugins tree, #307), so an unmarked cell here doesn't just omit a
          badge, it actively paints a verdict nothing has checked yet. Same in-panel-notice shape
          as the actionError banner below it (there is no WebviewPanel.message the way TreeView
          has one), clears itself with no user action once refresh() next lands a settled
          `conflictsComputed` — see the SESSION_CONFLICTS_COMPUTED handler above. */}
      {recordPanelIncompleteMessage(conflictsComputed) && (
        <div style={{ flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-editorWarning-foreground, #cca700)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)', borderRadius: 2 }}>
          {recordPanelIncompleteMessage(conflictsComputed)}
        </div>
      )}
      {/* Issue #175: flex:1 + minHeight:0 lets this wrapper shrink to the remaining viewport
          space instead of growing with the table's full height (the flex-item default of
          min-height:auto would otherwise defeat this). overflow:auto then gives it its own
          native scrollbars pinned to its own (viewport-bound) edges, so the horizontal scrollbar
          stays reachable regardless of vertical scroll position — it never lives at the bottom
          of unbounded content. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...headerCell, textAlign: 'left', minWidth: '160px' }}>Field</th>
              {columns.map(col => {
                {
                  // #272 / ADR-0036: collapsedColumns/immutableSet are keyed by col.key
                  // (ColumnKey), not the bare plugin filename — two same-filename columns must
                  // collapse/read-only independently. columnHeaderContext still gets the real
                  // plugin+origin pair (col.override.plugin/.origin), never the compound key.
                  const isCollapsed = collapsedColumns.has(col.key);
                  const isImmutable = immutableSet.has(col.key);
                  // #304 / ADR-0035: the column's own load-order membership — distinct from
                  // isImmutable (see recordUtils.ts's readOnlyReason) — drives both the header's
                  // reason wording and the dimming that carries down through every cell in this
                  // column (DiffRow, below), matching the tree row's own treatment (ADR-0035:
                  // "non-participating copies render dimmed").
                  const inLoadOrder = !notInLoadOrderSet.has(col.key);
                  return (
                    <th
                      key={`disk:${col.key}`}
                      style={{
                        ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px',
                        backgroundColor: getHeaderBg(col.override.conflictThis),
                        opacity: inLoadOrder ? undefined : DIMMED_OPACITY,
                      }}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={isImmutable}
                        inLoadOrder={inLoadOrder}
                        showOriginInline={collidingPluginNames.has(col.override.plugin)}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.key)}
                      />
                    </th>
                  );
                }
              })}
            </tr>
          </thead>
          <tbody>
            {/* Issue #231: VMAD/Condition rows are woven into the same flatMap as every ordinary
                field — one row list, one recursive builder, no separate section/renderer. */}
            {[...diffs, ...vmadTree.diffs, ...conditionTree.diffs].flatMap(
              diff => buildRows(diff, fieldMetaMap[diff.fieldName], [], diff.wirePath ?? diff.fieldName, diff, diff.fieldName),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
