import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { DiffRow, type FocusedCell } from './DiffRow';
import {
  buildColumns, parseElementIndex, keyedElementIndex, collidingFilenames,
  getAtPath, setAtPath, metaAtPath,
  headerCellContext, combineVscodeContexts,
} from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, headerCell, getConflictBg, DIMMED_OPACITY } from './gridStyles';
import { collapsedSummaries } from './presentation';
import { clearIdleSiblings, idleMembers } from './siblingsInUse';
import type { ColumnKey, CompareOverride, CompareResult, ConflictThis, FieldDiff, FieldMetadata } from './types';
import { columnKey } from './types';
import { vscode } from './vscode';
import { editField, openExtendedFieldEditor } from './nativeBridge';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';
import type { RecordPanelClient } from './RecordPanelClient';
import { recordPanelIncompleteMessage } from '../../src/medit/loadOrderProgress';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

// The four array arity/order gestures — shared by the op-name table and handleArrayOp below
// rather than each repeating the same literal union.
type ArrayOpKind = 'add' | 'remove' | 'moveUp' | 'moveDown';

// #630: the op-envelope name each arity op sends under an ordinary reflected field's own
// fieldPath — RecordFieldWriter/ArrayOpWriter's own vocabulary (ArrayOpWriter.IsArrayOp).
const ARRAY_OP_NAMES = {
  add: 'array_add', remove: 'array_remove', moveUp: 'array_move_up', moveDown: 'array_move_down',
} as const;

// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0035: mirrors immutableSet's own state shape — a copy the load order doesn't name
  // (distinct from "is immutable"; see recordUtils.ts's readOnlyReason) drives PluginHeader's
  // dimming/tooltip wording independently of the plain immutable fact.
  const [notInLoadOrderSet, setNotInLoadOrderSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0041: the columns whose plugin's mod is tracked. Starts empty and stays empty until
  // a load says otherwise — fail-closed, so a panel that has not heard from /plugins offers no
  // editing rather than offering edits that cannot land.
  const [trackedSet, setTrackedSet] = useState<Set<ColumnKey>>(new Set());
  // ADR-0035: whether the winner sweep has run — GET /load-order/status's own field, read by
  // client.load() alongside compare/changes/plugins. Initial `true` only matters until the first
  // load lands (the `!result` early-return below renders "Loading…" until then, so this can never
  // read as a false "settled" to the user); every value after that comes straight off the load's
  // own `conflictsComputed`, which is a required field precisely so there is no silent fallback
  // here that could paper over a status fetch nobody checked.
  const [conflictsComputed, setConflictsComputed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // ADR-0034: the single source of truth for "which value cell is focused," shared
  // by every DiffRow instance so at most one cell across the field grid is ever focused at once —
  // DiffRow itself only knows about its own row. `rowKey` matches the string this component
  // already computes for each DiffRow's own `key=` below. Deliberately reset on LOAD_RECORD (a
  // different record has no "same cell" to keep focused — mirrors the result/allChanges resets
  // there) but left untouched by refresh() (same-record reload from staging or a background
  // refresh, where the focused cell should survive).
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  function handleFocusCell(rowKey: string, plugin: ColumnKey) {
    setFocusedCell({ rowKey, plugin });
  }
  // Collapsed plugin columns, keyed by column identity (ColumnKey, not the bare
  // plugin name — two same-filename columns must collapse independently). Deliberately NOT reset
  // by the LOAD_RECORD handler below — collapse state is meant to persist across record-to-record
  // navigation within the same panel load order.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set());
  // ADR-0041: the one definition of "this column can be written", computed once for the whole
  // grid. Four conditions, all of them already known here: the plugin is not immutable (a vanilla
  // or DLC master), the load order actually names this copy (editing a shadowed one changes nothing
  // anywhere), the plugin's mod is tracked (editing requires tracking; viewing never does), and
  // the column's own override is not a Partial Form record — its fields are read-only on
  // the single write path (RecordEditRefusal.PartialFormFieldReadOnly) with no exemption here.
  // The header write (is_partial_form) is exempt from that refusal, but is dispatched
  // straight from PluginHeader's own checkbox rather than through this body-field gate — clearing
  // the flag is what lifts this gate for every other field, so it cannot itself be gated by it.
  //
  // Derived rather than asked of the backend per cell: the panel already holds all four facts from
  // its own load()/result, and a per-cell round trip would make editability lag the grid it decorates.
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

  // One field edit leaves for the single write path. Nothing is applied optimistically — the
  // grid keeps showing the committed value until the host reports the edit landed and the panel
  // re-reads (RECORD_EDITED). An optimistic patch would show a value the write path had not
  // actually accepted, which for a refused edit is a lie the user never gets corrected.
  const handleEditCell = useCallback((plugin: ColumnKey, fieldPath: string, value: unknown) => {
    // The override carries the compound identity the write path needs; the column key alone is a
    // rendering key, not something the backend can resolve (ADR-0036).
    const override = (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin);
    if (!override) return;
    editField(formKey, override.plugin, override.origin, fieldPath, value);
  }, [result, formKey]);

  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    try {
      setError(null);
      const loaded = await client.load(fk);
      if (!loaded.ok) throw new Error(loaded.error);
      setResult(loaded.result);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
      if (loaded.notInLoadOrderSet) setNotInLoadOrderSet(loaded.notInLoadOrderSet);
      // `??`, not a truthiness guard like the two above — those degrade to "unrestricted" on
      // a failed fetch, which is safe for them; this one has to degrade to "nothing is editable",
      // so a null must actively clear the set rather than leave a previous record's answer standing.
      setTrackedSet(loaded.trackedSet ?? new Set());
      // No `?? true` fallback. Against a real client, `conflictsComputed` is required on
      // LoadResult (RecordPanelClient.ts), so a genuine response omitting it fails to compile.
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

  // The header record (synthetic FormKey "000000:<plugin>") — computed here, ahead of every hook
  // that needs it (fieldMetaMap's masters-readOnly stamp below), since hooks can't follow the
  // early-return guards that precede where the rest of the render logic would naturally compute
  // this.
  const isHeaderRecord = formKey.startsWith('000000:');

  const fieldMetaMap = useMemo((): Record<string, FieldMetadata> => {
    const map: Record<string, FieldMetadata> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    // ADR-0038: the header record's masters field displays but is never directly editable —
    // stamped readOnly here rather than gated a second way, so every
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
  }, [result, isHeaderRecord]);

  const handleArrayOp = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string, op: ArrayOpKind,
  ) => {
    handleEditCell(plugin, rootField, { op: ARRAY_OP_NAMES[op], path });
  }, [handleEditCell]);

  // One *value* edit, committed the way the arity ops above already commit an arity change —
  // the whole complex field, reconstructed. CONTEXT.md: a complex field is "always edited as one
  // atomic value — a field-level write to the source document, never per-element". A
  // leaf inside an array/struct must never send its own bare value under the *root's* field path —
  // the backend's list/struct applier declines that shape.
  //
  // `rootDiff` is passed in rather than looked up: buildRows already holds this row's own subtree
  // root. A subtree root *is* the value it writes, so its commit stays the bare value.
  //
  // A member that declares which of its siblings its value keeps in use
  // (FieldMetadata.siblingsInUse) carries a cascade, and this is where the element is assembled, so
  // this is where the cascade applies — for every write path, the inline editor and the extended
  // one alike, since both come through here. The edited member's own schema is derived from the
  // path rather than passed in, so no caller can forget to.
  const handleCellCommit = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string, rootDiff: FieldDiff, value: unknown,
  ) => {
    const next = path.length === 0 ? value : setAtPath(rootDiff.values[plugin], path, value);
    const meta = metaAtPath(fieldMetaMap[rootField], path);
    const owner = path.slice(0, -1);
    const ownerMeta = metaAtPath(fieldMetaMap[rootField], owner);
    handleEditCell(plugin, rootField, meta?.siblingsInUse && path.length > 0
      ? setAtPath(next, owner, clearIdleSiblings(meta, ownerMeta?.fields ?? [], getAtPath(next, owner)))
      : next);
  }, [handleEditCell, fieldMetaMap]);

  // ADR-0039: a string cell's value, opened in a real editor tab.
  // Reached only from the cell's right-click menu (FIELD_OPEN_EXTENDED_EDITOR's own listener
  // branch below) — no left-click gesture may reach it.
  //
  // Commits through the identical whole-field reconstruction handleCellCommit already gives
  // every inline edit — `path`/`rootField` travel the whole way from the row's own right-click
  // context
  // (stringValueContext, recordUtils.ts) through FIELD_OPEN_EXTENDED_EDITOR, so a string leaf
  // nested inside a struct/array reconstructs the whole subtree exactly the way an inline edit on
  // the same cell does, instead of sending the saved text alone under the subtree's root
  // path. `rootDiff` is resolved by name off `result.diffs`, where every field's own root sits.
  const handleOpenExtended = useCallback((
    plugin: ColumnKey, fieldPath: string, path: PathSegment[], rootField: string, value: string, readOnly: boolean,
  ) => {
    const override = (result?.overrides ?? []).find(o => columnKey(o.plugin, o.origin) === plugin);
    if (!override) return;
    // The composite label — the same "EditorID [FormKey]" string the FormKey picker
    // seeds with and the header displays, so the tab's directory names the record the same way
    // every other identity-bearing surface here already does.
    const displayId = (result?.overrides.find(o => o.isWinner) ?? result?.overrides[0])?.editorId;
    const recordLabel = displayId ? `${displayId} [${formKey}]` : formKey;
    const rootDiff = (result?.diffs ?? []).find(d => d.fieldName === rootField);
    openExtendedFieldEditor(
      { value, recordLabel, fieldName: fieldPath, plugin: override.plugin, origin: override.origin, readOnly },
      (v: string) => { if (rootDiff) handleCellCommit(plugin, path, rootField, rootDiff, v); },
    );
  }, [result, formKey, handleCellCommit]);

  // Listen for loadRecord messages from the extension (panel reuse), the load order's own
  // conflicts-computed signal, and the array-op right-click commands — the
  // broadcast-and-self-filter shape (the extension host has no live reference into this
  // panel's own React state, which alone holds the record's current values). Depends on the
  // handlers it calls (they close over `result`/`formKey`), re-subscribing on change — cheap,
  // and what lets the handlers be used directly instead of through a mirror ref each.
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
        // ADR-0035: a panel already open when the sweep lands must reflect the settled
        // data, not just clear its own banner over stale content — refresh() re-runs client.load()
        // in full, so the grid and the banner update together in one state change. Load-order-wide,
        // not record-specific, so no self-filter — every open panel reacts.
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
  }, [refresh, handleArrayOp, handleEditCell, handleOpenExtended, fieldMetaMap]);

  // ADR-0036: keyed by ColumnKey, not the bare plugin filename — two overrides
  // sharing a filename but differing in origin would otherwise collide here, the second silently
  // discarding the first. Every consumer of this map reads it by ColumnKey. Declared as
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

  // ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — computed from this response's own overrides (never the load order's whole plugin
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

  // `result.conflictAll` (record-wide) is not threaded into the compare grid's
  // row background — that's each row's own `diff.conflictAll` (DiffRow), computed bottom-up
  // per node. The record-wide value is the Plugins-tree's own record badge, sourced there
  // independently — this component has no use for it.
  const { overrides, diffs } = result;

  const winner = overrides.find(o => o.isWinner);
  const displayId = (winner ?? overrides[0])?.editorId;
  const title = displayId ? `${displayId} [${formKey}]` : formKey;

  // One recursive builder for every nesting depth — including the recursion a script property's
  // own struct members need, rather than a second deep path bolted alongside. `path`/`rootField`
  // are RowContext's own fields
  // (DiffRow.tsx) — every row in one subtree stages through the same rootField, and getAtPath/
  // setAtPath (recordUtils.ts) are the one generic read/write every depth shares.
  //
  // `meta` is this node's own resolved FieldMetadata (undefined only for a malformed diff tree —
  // DiffRow's own `context.overrideMeta`-driven null-return handles that at render time, exactly
  // as it always has); `rootDiff` is the top of this subtree (its `values` are what handleArrayOp
  // reads the current array from). `isUnsortedArrayElement` is supplied by the *parent* call
  // (buildArrayElementRows) when this row is itself an unsorted array's element — never computed
  // by a row for itself, since only the parent knows which array it just descended into.
  function buildRows(
    diff: FieldDiff, meta: FieldMetadata | undefined, path: PathSegment[],
    rootField: string, rootDiff: FieldDiff, rowKey: string, isUnsortedArrayElement = false, depth = 0,
    collapsedSummary?: Record<string, string>,
  ): React.ReactNode[] {
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = expandedStructs.has(rowKey);
    // This row is itself a mutable, unsorted array's own row (Add applies).
    const isUnsortedArrayParent = meta?.type === 'array' && !!meta.elementType && !meta.elementType.isSortable;

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        diff={diff}
        columns={columns}
        overrideMap={overrideMap}
        fieldMetaMap={fieldMetaMap}
        notInLoadOrderSet={notInLoadOrderSet}
        editableColumns={editableColumns}
        onEditCell={(plugin: ColumnKey, value: unknown) => handleCellCommit(plugin, path, rootField, rootDiff, value)}
        onArrayAdd={isUnsortedArrayParent ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'add') : undefined}
        onArrayRemove={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'remove') : undefined}
        onArrayMoveUp={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveUp') : undefined}
        onArrayMoveDown={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveDown') : undefined}
        collapsedColumns={collapsedColumns}
        onOpen={handleOpen}
        context={{ path, overrideMeta: meta, rootField, depth }}
        rowKey={rowKey}
        focusedCell={focusedCell}
        onFocusCell={handleFocusCell}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        collapsedSummary={collapsedSummary}
        onToggle={() => setExpandedStructs(prev => {
          const next = new Set(prev);
          if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey);
          return next;
        })}
      />,
    ];

    if (!hasChildren || !isExpanded || !meta) return rows;

    // A member the schema says holds no data under any column's current value has no row —
    // Mutagen aliases a condition's parameter slots onto the same bytes, so the idle twin of a
    // live slot would render the same four bytes a second time as a different type. Filtering
    // only ever removes a row the diff already has; nothing here synthesizes one.
    const idle = meta.type === 'struct' ? idleMembers(meta, columns.map(c => diff.values[c.key])) : undefined;

    for (const child of diff.children ?? []) {
      if (idle?.has(child.fieldName)) continue;
      const childRowKey = `${rowKey}.${child.fieldName}`;
      if (meta.type === 'array' && meta.elementType) {
        rows.push(...buildArrayElementRows(
          child, meta, path, rootField, rootDiff, childRowKey, depth, diff.values));
      } else if (meta.type === 'struct') {
        const memberMeta = meta.fields?.find(f => f.name === child.fieldName);
        rows.push(...buildRows(
          child, memberMeta, [...path, { kind: 'member', name: child.fieldName }],
          rootField, rootDiff, childRowKey, false, depth + 1));
      }
    }
    return rows;
  }

  // How the backend labelled this child is what says how to address it, since both answers come
  // from the same array metadata: a keyed array's children are named by key (ConflictClassifier's
  // BuildKeyed), a pure-FormLink array's by the element value, and every other array's by "[N]".
  function elementSegment(arrayMeta: FieldMetadata, fieldName: string): PathSegment {
    if (arrayMeta.keyMembers) return { kind: 'key', key: fieldName, members: arrayMeta.keyMembers };
    if (arrayMeta.elementType?.isSortable) return { kind: 'sortKey', key: fieldName };
    return { kind: 'index', index: parseElementIndex(fieldName) };
  }

  function buildArrayElementRows(
    child: FieldDiff, arrayMeta: FieldMetadata, arrayPath: PathSegment[], rootField: string, rootDiff: FieldDiff,
    childRowKey: string, depth: number, listValues: Record<string, unknown>,
  ): React.ReactNode[] {
    const elementMeta = arrayMeta.elementType!;
    const seg = elementSegment(arrayMeta, child.fieldName);
    // The presentation table's unit is one element of a list, and "is this the last one" is a
    // question about the list — which only this frame, the one that descended into it, can answer.
    // Same rule `isUnsortedArrayElement` already follows: a row is never told by itself.
    const collapsedSummary = collapsedSummaries(child, elementMeta, column => {
      const list = listValues[column];
      if (!Array.isArray(list)) return true;
      if (seg.kind === 'index') return seg.index === list.length - 1;
      // A keyed element sits at a different position in each column, so this is asked of that
      // column's own array rather than answered once for the row.
      if (seg.kind === 'key') return keyedElementIndex(list, seg) === list.length - 1;
      return true;
    });
    return buildRows(
      child, elementMeta, [...arrayPath, seg], rootField, rootDiff, childRowKey,
      seg.kind !== 'sortKey', depth + 1, collapsedSummary);
  }

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
      {/* ADR-0035: the record editor's own "an absent conflict badge must never be
          mistakable for 'no conflict'" statement — this surface renders conflict colouring
          today (unlike the Plugins tree), so an unmarked cell here doesn't just omit a
          badge, it actively paints a verdict nothing has checked yet. Same in-panel-notice shape
          as the actionError banner below it (there is no WebviewPanel.message the way TreeView
          has one), clears itself with no user action once refresh() next lands a settled
          `conflictsComputed` — see the CONFLICTS_COMPUTED handler above. */}
      {recordPanelIncompleteMessage(conflictsComputed) && (
        <div style={{ flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-editorWarning-foreground, #cca700)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)', borderRadius: 2 }}>
          {recordPanelIncompleteMessage(conflictsComputed)}
        </div>
      )}
      {/* flex:1 + minHeight:0 lets this wrapper shrink to the remaining viewport
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
                  // ADR-0036: collapsedColumns/immutableSet are keyed by col.key
                  // (ColumnKey), not the bare plugin filename — two same-filename columns must
                  // collapse/read-only independently. columnHeaderContext still gets the real
                  // plugin+origin pair (col.override.plugin/.origin), never the compound key.
                  const isCollapsed = collapsedColumns.has(col.key);
                  const isImmutable = immutableSet.has(col.key);
                  // ADR-0035: the column's own load-order membership — distinct from
                  // isImmutable (see recordUtils.ts's readOnlyReason) — drives both the header's
                  // reason wording and the dimming that carries down through every cell in this
                  // column (DiffRow, below), matching the tree row's own treatment (ADR-0035:
                  // "non-participating copies render dimmed").
                  const inLoadOrder = !notInLoadOrderSet.has(col.key);
                  // A Partial Form column dims the same way a not-in-load-order one does —
                  // xEdit's own answer ("shown as such, not as a full competing override") applied
                  // to mEdit's never-hide-data posture. Read straight off col.override.isPartialForm
                  // rather than a separately-threaded Set, since the fact already rides on this
                  // column's own data.
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
                        // The one sanctioned header-flag write, through the same handleEditCell
                        // every other field edit on this panel already goes through — is_partial_form
                        // is exempt from RecordEditService's own Partial Form read-only guard
                        // (RecordEditService.cs), so this reaches the backend regardless of the
                        // column's current isPartialForm state.
                        onTogglePartialForm={next => handleEditCell(col.key, 'is_partial_form', next)}
                      />
                    </th>
                  );
                }
              })}
            </tr>
          </thead>
          <tbody>
            {diffs.flatMap(
              diff => buildRows(diff, fieldMetaMap[diff.fieldName], [], diff.fieldName, diff, diff.fieldName),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
