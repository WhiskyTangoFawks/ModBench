import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { DiffRow, type FocusedCell } from './DiffRow';
import {
  buildColumns, parseElementIndex, collidingFilenames,
  getAtPath, setAtPath, metaAtPath, appendArrayElement, removeArrayElement, moveArrayElement, defaultElementValue,
  headerCellContext, combineVscodeContexts,
} from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, headerCell, getConflictBg, DIMMED_OPACITY } from './gridStyles';
import { buildVmadRows } from './vmadTreeAdapter';
import { AddPropertyDialog } from './VmadPropertyOps';
import { buildConditionRows } from './conditionTreeAdapter';
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

// A synthesized row can write independently of its own parent rather than
// extending it — a VMAD property under its script container, or a Condition field under its
// condition element, each write their own field path rather than folding into the
// whole subtree their parent writes (a complex field is always written as one atomic unit,
// CONTEXT.md). `FieldDiff.wirePath` is the
// signal: when a child carries one, it starts a fresh subtree right there (its own path resets to
// `[]`, rootField becomes its own wirePath, rootDiff becomes itself) instead of inheriting the
// parent's. An ordinary reflected field's children never carry `wirePath` (only the VMAD/
// Condition tree adapters set it), so this is a no-op for every ordinary case.
// Module-scope (not a RecordPanel-
// local closure like buildRows/buildArrayElementRows below) since it closes over nothing.
function subtreeFor(
  child: FieldDiff, seg: PathSegment, path: PathSegment[], rootField: string, rootDiff: FieldDiff,
): { path: PathSegment[]; rootField: string; rootDiff: FieldDiff } {
  if (child.wirePath !== undefined) return { path: [], rootField: child.wirePath, rootDiff: child };
  return { path: [...path, seg], rootField, rootDiff };
}

// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordPanelClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  // The Run On target dropdown's catalog (GET /condition-run-on-targets) — a
  // load-order-wide list, not per-record, so it's fetched once on mount rather than on every
  // refresh()/load(fk). Starts empty (the Run On cell simply has nothing to show until this
  // resolves) rather than falling back to any hardcoded list. No `.catch` needed here:
  // client.conditionRunOnTargets() never rejects — it logs and degrades to [] on both a non-ok
  // response and a thrown network error itself (RecordPanelClient.ts), the same contract
  // PluginRepository.getConditionFunctions() gives its own callers.
  const [runOnTargets, setRunOnTargets] = useState<string[]>([]);
  useEffect(() => { void client.conditionRunOnTargets().then(setRunOnTargets); }, [client]);
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
  // Add Property's own dialog state — which script/column VMAD_OPEN_ADD_PROPERTY
  // named, or null when no dialog is open. AddPropertyDialog itself (VmadPropertyOps.tsx) collects
  // name/type/value; this only remembers *where* to commit them once it confirms.
  const [addPropertyDialog, setAddPropertyDialog] = useState<{ scriptName: string; plugin: ColumnKey } | null>(null);

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

  const refreshRef = useRef(refresh);
  useLayoutEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

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

  // The header record (synthetic FormKey "000000:<plugin>") carries neither VMAD
  // nor Conditions — computed here (ahead of every hook that needs it, including
  // fieldMetaMap's masters-readOnly stamp below) since hooks can't follow the early-return guards
  // that precede where the rest of the render logic would naturally compute this.
  const isHeaderRecord = formKey.startsWith('000000:');

  // VMAD and Conditions map into the same node shape (FieldDiff + FieldMetadata) the
  // ordinary reflected fields already use — vmadTreeAdapter.ts/conditionTreeAdapter.ts are pure
  // functions with no rendering of their own, so their rows flow through the exact same
  // buildRows/DiffRow path below as any other field, with no separate section renderer.
  const vmadTree = useMemo(
    () => (isHeaderRecord || !result?.hasVmad) ? { diffs: [], metaMap: {} } : buildVmadRows(result.vmad),
    [result, isHeaderRecord],
  );
  const conditionTree = useMemo(
    () => isHeaderRecord ? { diffs: [], metaMap: {} } : buildConditionRows(result?.conditions, runOnTargets),
    [result, isHeaderRecord, runOnTargets],
  );

  // The four array-arity/order ops (Add/Remove/Move Up/Move
  // Down) — one generic handler for every unsorted array in the tree (an ordinary reflected
  // field, or a VMAD array-of-scalars property reusing this exact same machinery), rather
  // than a per-field special case. `rootField` locates the subtree's own root FieldDiff (whichever
  // of diffs/vmadTree.diffs/conditionTree.diffs it came from); `path` addresses the array within
  // that root's own per-column value (getAtPath/setAtPath, the same generic accessors every field
  // commit already writes through). `elementMeta` is only needed for 'add' (defaultElementValue).
  const handleArrayOp = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string,
    op: 'add' | 'remove' | 'moveUp' | 'moveDown', elementMeta?: FieldMetadata,
  ) => {
    const rootDiff = [...(result?.diffs ?? []), ...vmadTree.diffs, ...conditionTree.diffs]
      .find(d => (d.wirePath ?? d.fieldName) === rootField);
    if (!rootDiff) return;
    const rootValue = rootDiff.values[plugin];
    // 'add' addresses the array itself; every other op addresses one of its elements, so the
    // array is one hop shorter than the row's own path (the last hop is the element's own index).
    const arrayPath = op === 'add' ? path : path.slice(0, -1);
    const current = getAtPath(rootValue, arrayPath);
    const currentArray = Array.isArray(current) ? current : [];
    const lastSeg = path[path.length - 1];
    const index = lastSeg?.kind === 'index' ? lastSeg.index : -1;
    const nextArray = op === 'add' ? appendArrayElement(currentArray, defaultElementValue(elementMeta ?? { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] }))
      : op === 'remove' ? removeArrayElement(currentArray, index)
      : moveArrayElement(currentArray, index, op === 'moveUp' ? -1 : 1);
    if (nextArray === currentArray) return; // boundary no-op — nothing to write
    handleEditCell(plugin, rootField, setAtPath(rootValue, arrayPath, nextArray));
  }, [result, vmadTree, conditionTree, handleEditCell]);

  // One *value* edit, committed the way the arity ops above already commit an arity change —
  // the whole complex field, reconstructed. CONTEXT.md: a complex field is "always edited as one
  // atomic value — a field-level write to the source document, never per-element". A
  // leaf inside an array/struct must never send its own bare value under the *root's* field path —
  // the backend's list/struct applier declines that shape.
  //
  // `rootDiff` is passed in rather than looked up the way handleArrayOp looks it up: buildRows
  // already holds this row's own subtree root, and that by-name search over top-level diffs cannot
  // find a VMAD property's diff at all (those are children of a script row, not top-level entries).
  //
  // `path.length === 0` is not an optimization — it is the whole VMAD/Condition story. A subtree
  // root (an ordinary top-level field, a VMAD property, a Condition field) *is* the value it writes,
  // so its commit stays the bare value.
  const handleCellCommit = useCallback((
    plugin: ColumnKey, path: PathSegment[], rootField: string, rootDiff: FieldDiff, value: unknown,
  ) => {
    handleEditCell(
      plugin, rootField,
      path.length === 0 ? value : setAtPath(rootDiff.values[plugin], path, value));
  }, [handleEditCell]);

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
  // path. `rootDiff` is resolved by name across the flattened top-level
  // diffs — the same lookup handleArrayOp above already uses, and the same known gap: a VMAD
  // property's own FieldDiff is a child of its script row, never a top-level entry, so a VMAD
  // string property's extended-editor save can't find its root here and silently no-ops.
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
    const rootDiff = [...(result?.diffs ?? []), ...vmadTree.diffs, ...conditionTree.diffs]
      .find(d => (d.wirePath ?? d.fieldName) === rootField);
    openExtendedFieldEditor(
      { value, recordLabel, fieldName: fieldPath, plugin: override.plugin, origin: override.origin, readOnly },
      (v: string) => { if (rootDiff) handleCellCommit(plugin, path, rootField, rootDiff, v); },
    );
  }, [result, vmadTree, conditionTree, formKey, handleCellCommit]);

  const fieldMetaMap = useMemo((): Record<string, FieldMetadata> => {
    const map: Record<string, FieldMetadata> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    Object.assign(map, vmadTree.metaMap, conditionTree.metaMap);
    // ADR-0038: the header record's masters field displays but is never directly editable —
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

  // The message listener below is mount-once ([] deps), but handleArrayOp's and
  // fieldMetaMap's own identities change on every edit/reload (they close over `result`) — a ref
  // keeps the broadcast handler calling the *current* versions rather than the ones captured at
  // mount, the same shape refreshRef already uses for the same reason. Declared here (after both
  // are computed) purely because a ref's own initial value has to be able to read the thing it
  // refs — and the message listener itself is declared after these two, not beside the others
  // above, so every ref it closes over (refreshRef included) is already in scope by then, keeping
  // one linear read order instead of forward-referencing.
  const handleArrayOpRef = useRef(handleArrayOp);
  useLayoutEffect(() => { handleArrayOpRef.current = handleArrayOp; }, [handleArrayOp]);
  const fieldMetaMapRef = useRef(fieldMetaMap);
  useLayoutEffect(() => { fieldMetaMapRef.current = fieldMetaMap; }, [fieldMetaMap]);
  // VMAD_STRUCTURAL_OP's own commit reaches through handleEditCell directly (the
  // op-envelope value is already in EDIT_FIELD's own wire shape — RecordFieldWriter.ApplyVmadField
  // dispatches on it) — same ref-for-a-mount-once-listener shape as handleArrayOpRef above, for the
  // same reason (handleEditCell closes over `result`/`formKey`, both of which change).
  const handleEditCellRef = useRef(handleEditCell);
  useLayoutEffect(() => { handleEditCellRef.current = handleEditCell; }, [handleEditCell]);
  // ADR-0039: FIELD_OPEN_EXTENDED_EDITOR's own commit reaches through handleOpenExtended —
  // same ref-for-a-mount-once-listener shape as handleEditCellRef/handleArrayOpRef above, for the
  // same reason (handleOpenExtended closes over `result`/`vmadTree`/`conditionTree`/`formKey`/
  // `handleCellCommit`, all of which change). Reached only from this broadcast, the right-click
  // menu's own trigger.
  const handleOpenExtendedRef = useRef(handleOpenExtended);
  useLayoutEffect(() => { handleOpenExtendedRef.current = handleOpenExtended; }, [handleOpenExtended]);

  // Listen for loadRecord messages from the extension (panel reuse), the load order's own
  // conflicts-computed signal, and the array-op right-click commands — the
  // broadcast-and-self-filter shape (the extension host has no live reference into this
  // panel's own React state, which alone holds the record's current values).
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
        void refreshRef.current(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.RECORD_EDITED) {
        // The edit landed as a working-tree change. Re-read rather than patch: the write
        // path re-serialized the record through the codec, and this record's conflict picture
        // across every other column may have moved with it.
        if (msg.formKey === prevFormKeyRef.current) void refreshRef.current(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED) {
        // ADR-0035: a panel already open when the sweep lands must reflect the settled
        // data, not just clear its own banner over stale content — refresh() re-runs client.load()
        // in full, so the grid and the banner update together in one state change. Load-order-wide,
        // not record-specific, so no self-filter — every open panel reacts.
        void refreshRef.current(prevFormKeyRef.current);
      } else if (
        msg.type === EXTENSION_TO_WEBVIEW.ARRAY_ADD || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_REMOVE
        || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN
      ) {
        // Self-filter on formKey — a changeId-less broadcast (there is no per-change id here).
        // Only reachable while this exact record is open, so a
        // stale/background panel showing a different record ignores it.
        if (msg.formKey !== prevFormKeyRef.current) return;
        const plugin = columnKey(msg.plugin, msg.origin);
        const op = msg.type === EXTENSION_TO_WEBVIEW.ARRAY_ADD ? 'add'
          : msg.type === EXTENSION_TO_WEBVIEW.ARRAY_REMOVE ? 'remove'
          : msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP ? 'moveUp' : 'moveDown';
        // `msg.path` is the carried path (the array itself for 'add', the element for every
        // other op) — never re-synthesized from a bare scalar index, which would only
        // address a top-level array correctly. `metaAtPath` resolves the *array's own*
        // element type from the subtree root's meta, walking the same hops the value itself sits
        // behind — reading `fieldMetaMapRef.current[msg.rootField]?.elementType` directly
        // would only find the right element type when the array is itself the subtree
        // root; for a nested array it would name the wrong node's (or no) elementType, and Add
        // would append a malformed element.
        const arrayPath = op === 'add' ? msg.path : msg.path.slice(0, -1);
        const arrayMeta = metaAtPath(fieldMetaMapRef.current[msg.rootField], arrayPath);
        handleArrayOpRef.current(plugin, msg.path, msg.rootField, op, arrayMeta?.elementType ?? undefined);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP) {
        // Same self-filter-and-commit shape as the array-op branch above, except the
        // op-envelope value is already the exact shape handleEditCell/EDIT_FIELD always carries —
        // no webview-side computation of a next value, unlike an array op.
        if (msg.formKey !== prevFormKeyRef.current) return;
        handleEditCellRef.current(columnKey(msg.plugin, msg.origin), msg.fieldPath, msg.value);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY) {
        if (msg.formKey !== prevFormKeyRef.current) return;
        setAddPropertyDialog({ scriptName: msg.scriptName, plugin: columnKey(msg.plugin, msg.origin) });
      } else if (msg.type === EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR) {
        // ADR-0039: the string-cell right-click command's own broadcast — self-filter on
        // formKey, same convention as every other right-click op above, then hand off to the
        // bridge call.
        if (msg.formKey !== prevFormKeyRef.current) return;
        handleOpenExtendedRef.current(
          columnKey(msg.plugin, msg.origin), msg.fieldName, msg.path, msg.rootField, msg.value, msg.readOnly,
        );
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

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

  // One recursive builder for every nesting depth — the recursion VMAD's own struct data
  // needs (Schema/VmadCodec.cs: "the (de)serializer descends to arbitrary depth"),
  // rather than a second,
  // VMAD-only deep path bolted alongside. `path`/`rootField` are RowContext's own fields
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
    rootField: string, rootDiff: FieldDiff, rowKey: string, isUnsortedArrayElement = false,
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
        onArrayAdd={isUnsortedArrayParent ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'add', meta?.elementType ?? undefined) : undefined}
        onArrayRemove={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'remove') : undefined}
        onArrayMoveUp={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveUp') : undefined}
        onArrayMoveDown={isUnsortedArrayElement ? (plugin: ColumnKey) => handleArrayOp(plugin, path, rootField, 'moveDown') : undefined}
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
    return buildRows(child, elementMeta, [...arrayPath, seg], rootField, rootDiff, childRowKey, !elementMeta.isSortable);
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
            {/* VMAD/Condition rows are woven into the same flatMap as every ordinary
                field — one row list, one recursive builder, no separate section/renderer. */}
            {[...diffs, ...vmadTree.diffs, ...conditionTree.diffs].flatMap(
              diff => buildRows(diff, fieldMetaMap[diff.fieldName], [], diff.wirePath ?? diff.fieldName, diff, diff.fieldName),
            )}
          </tbody>
        </table>
      </div>
      {/* Add Property's own webview modal — the one deliberate exception to
          right-click-menu commands resolving everything themselves (three fields at once: name,
          type, and a type-appropriate value). `addPropertyDialog` names which script/column
          VMAD_OPEN_ADD_PROPERTY opened it for; confirming builds the same op-envelope fieldPath/
          value shape every other VMAD structural op commits, through the identical handleEditCell
          write path. */}
      {addPropertyDialog && (
        <AddPropertyDialog
          onCancel={() => setAddPropertyDialog(null)}
          onConfirm={({ name, type, value }) => {
            handleEditCell(
              addPropertyDialog.plugin, `VMAD\\${addPropertyDialog.scriptName}\\${name}`,
              { op: 'add_property', name, type, value },
            );
            setAddPropertyDialog(null);
          }}
        />
      )}
    </div>
  );
}
