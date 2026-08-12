import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { confirmRevertGroup } from './nativeBridge';
import { DiffRow, type ArrayEditControls, type FocusedCell } from './DiffRow';
import { partialSaveMessage, staleIndexMessage } from '../../src/medit/saveClassification';
import { errorText } from '../../src/medit/ApiClient';
import {
  buildColumns, columnHeaderContext, currentMasters, defaultElementValue, parseElementIndex,
  appendArrayElement, removeArrayElement, moveArrayElement, getAtPath, setAtPath,
  vmadScriptsContext, vmadScriptContext, vmadPropertyContext,
} from './recordUtils';
import type { PathSegment } from './recordUtils';
import { mono, fg, baseCell, headerCell, getConflictBg } from './gridStyles';
import { buildVmadRows } from './vmadTreeAdapter';
import { buildConditionRows } from './conditionTreeAdapter';
import { parseVmadPath } from './vmadOps';
import { AddPropertyDialog } from './VmadPropertyOps';
import type { ColumnKey, CompareOverride, CompareResult, ConflictThis, FieldDiff, FieldMetadata, PatchRecordValidationError, PendingChange } from './types';
import { columnKey } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview, type LogLevel } from './messages';
import type { RecordSessionClient } from './RecordSessionClient';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

// Issue #174: the record editor webview and the extension host's Pending Changes tree are
// different processes, bridged only by postMessage — refresh(formKey) below only re-fetches
// this webview's own state, never the tree. Every handler that successfully stages, saves, or
// reverts a pending change calls this once the mutation is confirmed so extension.ts can
// refresh the tree in response.
function notifyPendingChanged() {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED });
}

// Issue #200: the webview has no route to the 'Modbench' output channel (#198) of its own —
// same bridge as notifyPendingChanged above. Message text carries identity only (plugin,
// field/path, formKey/changeId) — never the value itself, to avoid dumping array/struct
// payloads into the Output panel.
function logAction(level: LogLevel, message: string) {
  vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.LOG, level, message });
}

// Issue #200: shared by Save Group and Revert Group's log lines below — a changeId alone
// doesn't say which plugin/field/record was affected, and both handlers need the same lookup.
function changeIdentity(change: PendingChange | undefined): string {
  return change ? ` (${change.fieldPath} on ${change.plugin}, record ${change.formKey})` : '';
}

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

// Issue #231: finds the FieldDiff node (searching `children` recursively) whose own restage
// identity — `wirePath` if it carries one, its plain `fieldName` otherwise — matches
// `targetWirePath`. The array-op broadcast handlers (resolveCurrentArrayFor below) need this: a
// VMAD/Condition array row was never a reflected field (`overrideMap[plugin].fields` only ever
// lists those), so its own disk value has to be found in the synthesized diff tree instead, by
// the same wire identity the broadcast itself carries (`ArrayParentContext`/`ArrayElementContext`'s
// `fieldName`, which is `context.rootField` at the row that emitted it).
function findDiffByWirePath(nodes: FieldDiff[], targetWirePath: string): FieldDiff | undefined {
  for (const node of nodes) {
    if ((node.wirePath ?? node.fieldName) === targetWirePath) return node;
    const found = node.children && findDiffByWirePath(node.children, targetWirePath);
    if (found) return found;
  }
  return undefined;
}

// Issue #231 (review): the metadata-side counterpart to findDiffByWirePath above — `fieldMetaMap`
// already carries every *top-level* synthesized entry (vmadTree/conditionTree's own metaMap is
// merged into it), which is enough for a Condition list (always itself top-level) and the VMAD
// wrapper itself, but a VMAD property nested below a script has no flat metaMap entry of its own —
// only reachable by walking down from the wrapper's own `meta.fields`/`meta.elementType`, exactly
// buildRows'/buildArrayElementRows' own struct-child/array-element meta resolution during render.
// handleArrayAdd (below) needs this for the broadcast path, which has no row closure to read that
// resolution from the way a render does. Struct members are matched by name; array elements all
// share one `elementType` — arbitrary depth, the same "N hops, not a fixed cap" this ticket's
// other tree-walkers (findDiffByWirePath, vmadTreeAdapter's nodeAt/propertyAt) already establish.
function findMetaInChildren(children: FieldDiff[], parentMeta: FieldMetadata, targetWirePath: string): FieldMetadata | undefined {
  for (const child of children) {
    let childMeta: FieldMetadata | undefined;
    if (parentMeta.type === 'array') childMeta = parentMeta.elementType;
    else if (parentMeta.type === 'struct') childMeta = parentMeta.fields?.find(f => f.name === child.fieldName);
    if (!childMeta) continue;
    if ((child.wirePath ?? child.fieldName) === targetWirePath) return childMeta;
    const found = findMetaInChildren(child.children ?? [], childMeta, targetWirePath);
    if (found) return found;
  }
  return undefined;
}

function findMetaByWirePath(
  nodes: FieldDiff[], topMetaMap: Record<string, FieldMetadata>, targetWirePath: string,
): FieldMetadata | undefined {
  for (const node of nodes) {
    const meta = topMetaMap[node.wirePath ?? node.fieldName];
    if (!meta) continue;
    const found = findMetaInChildren(node.children ?? [], meta, targetWirePath);
    if (found) return found;
  }
  return undefined;
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
  const [allChanges, setAllChanges] = useState<PendingChange[]>([]);
  const [immutableSet, setImmutableSet] = useState<Set<ColumnKey>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  const dragPayloadRef = useRef<{ fieldName: string; value: unknown; sourcePlugin: ColumnKey } | null>(null);

  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    try {
      setError(null);
      const loaded = await client.load(fk);
      if (!loaded.ok) throw new Error(loaded.error);
      setResult(loaded.result);
      if (loaded.changes) setAllChanges(loaded.changes);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  const refreshRef = useRef(refresh);
  useLayoutEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // Issue #208: Save Group / Revert Group's actual work (client HTTP, the multi-member confirm,
  // the partial-save/stale-reindex banner) only exists in this webview — the native
  // modbench.pendingCell.saveGroup/revertGroup commands broadcast a changeId to every open
  // record panel rather than trying to guess which one was right-clicked (OS focus at command-
  // dispatch time isn't a reliable signal); each panel self-filters against its own allChanges
  // before acting, so at most one panel's check ever passes (a changeId is a global id — see
  // PendingChangesTreeProvider.resolveChange — never shared across two different records). The
  // mount-only message listener below needs the latest allChanges/handlers on every message, not
  // whatever closed over it at mount — same staleness problem refreshRef solves for refresh.
  const pendingCellActionsRef = useRef<{
    allChanges: PendingChange[];
    saveGroup: (changeId: string) => void;
    revertGroup: (changeId: string) => void;
  }>({ allChanges: [], saveGroup: () => {}, revertGroup: () => {} });

  // Issue #209: same staleness problem as pendingCellActionsRef above, for the column-header
  // menu's native commands (none of which carry a changeId — self-filtering is on `formKey`
  // instead, since these act on whichever record this panel currently has loaded, not a specific
  // pending change). copyAsNewRecord/copyAsOverride/removeOverride are called with the signatures
  // their own handlers already take; addMaster is synthesized here since the inline master picker
  // that used to own it (PluginHeader) is gone — see currentMasters below.
  // Issue #202: copyAllToPending deleted — Copy as Override now carries the right-clicked column
  // (sourcePlugin) through to the backend instead of a separate shallow-copy action.
  // #272 / ADR-0036: copyAsNewRecord/addMaster take a ColumnKey — both resolve through
  // overrideMap (Copy as New Record's field source, Add Master's current-masters read) before
  // ever reaching a real plugin filename. copyAsOverride/removeOverride stay bare plugin
  // filenames — neither does a local overrideMap lookup, and their write-target DTOs
  // deliberately don't carry origin (the server resolves it, ruling Q4/#6).
  const columnHeaderActionsRef = useRef<{
    formKey: string;
    copyAsNewRecord: (sourceKey: ColumnKey, targetPlugin: string) => void;
    copyAsOverride: (sourcePlugin: string, targetPlugin: string) => void;
    removeOverride: (plugin: string) => void;
    addMaster: (key: ColumnKey, newMaster: string) => void;
  }>({
    formKey: '', copyAsNewRecord: () => {}, copyAsOverride: () => {},
    removeOverride: () => {}, addMaster: () => {},
  });

  // Issue #227: same staleness problem as pendingCellActionsRef/columnHeaderActionsRef above, for
  // the array-element/array-parent menu's four native commands. Self-filtered on `formKey` like
  // columnHeaderActionsRef (there's no changeId concept for an array op) rather than forced
  // through the changeId pattern where it doesn't fit. #272: keyed by ColumnKey — every one of
  // these resolves its current array through overrideMap/the synthesized diff tree.
  const arrayOpActionsRef = useRef<{
    formKey: string;
    add: (key: ColumnKey, fieldName: string) => void;
    remove: (key: ColumnKey, fieldName: string, index: number) => void;
    moveUp: (key: ColumnKey, fieldName: string, index: number) => void;
    moveDown: (key: ColumnKey, fieldName: string, index: number) => void;
  }>({
    formKey: '', add: () => {}, remove: () => {}, moveUp: () => {}, moveDown: () => {},
  });

  // Issue #231: same staleness problem as arrayOpActionsRef above, for VMAD's own structural-op
  // menu commands (Add/Remove Script, Remove Property, Add Property). Self-filtered on `formKey`,
  // no changeId concept here either. #272: only openAddProperty takes a ColumnKey — it seeds
  // addPropertyTarget (react state carrying column identity across renders, per ADR-0036's own
  // ruling); the other five forward straight through to handleVmadStructOp with no local lookup,
  // so a bare plugin filename (write-target DTOs don't carry origin) is correct as-is.
  const vmadOpActionsRef = useRef<{
    formKey: string;
    addScript: (plugin: string, name: string) => void;
    removeScript: (plugin: string, scriptName: string) => void;
    removeProperty: (plugin: string, scriptName: string, propName: string) => void;
    openAddProperty: (key: ColumnKey, scriptName: string) => void;
    setScriptFlags: (plugin: string, scriptName: string, flags: string) => void;
    setPropertyFlags: (plugin: string, scriptName: string, propName: string, flags: string) => void;
  }>({
    formKey: '', addScript: () => {}, removeScript: () => {}, removeProperty: () => {}, openAddProperty: () => {},
    setScriptFlags: () => {}, setPropertyFlags: () => {},
  });

  // Issue #231: Add Property collects three fields at once (name, type, value) — #229's own
  // "one deliberate exception", a webview-rendered dialog rather than a QuickPick chain. The
  // right-click command has nothing to collect itself, so it only broadcasts "open the dialog for
  // this script/plugin" (VMAD_OPEN_ADD_PROPERTY) — this is that dialog's own open/closed state.
  const [addPropertyTarget, setAddPropertyTarget] = useState<{ plugin: ColumnKey; scriptName: string } | null>(null);

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

  // Listen for loadRecord messages from extension (panel reuse), plus #208's Save Group/Revert
  // Group and #209's column-header broadcasts from the native menu commands.
  useEffect(() => {
    // Issue #209: the column-header menu's broadcasts, factored out of `handler` below so its own
    // branching doesn't balloon — each one only fires when this panel is the one showing the
    // mutated record (formKey self-filter, no changeId here). #202: COLUMN_HEADER_COPY_AS_OVERRIDE
    // now carries sourcePlugin too (the right-clicked column, not necessarily the winner) —
    // COLUMN_HEADER_COPY_ALL_TO_PENDING is gone, that action's own case with it.
    const handleColumnHeaderMessage = (msg: ExtensionToWebview) => {
      const actions = columnHeaderActionsRef.current;
      if (!('formKey' in msg) || msg.formKey !== actions.formKey) return;
      if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD) {
        // #272: copyAsNewRecord resolves through overrideMap (its own field source has no
        // backend endpoint to ask), so the right-clicked column's real identity — not just its
        // plugin name — is what must reach it.
        actions.copyAsNewRecord(columnKey(msg.sourcePlugin, msg.sourceOrigin), msg.targetPlugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE) {
        // #272: copyAsOverride never looks anything up locally — CopyRecordTo's own write-target
        // DTO deliberately doesn't carry origin (the server resolves it), so the bare plugin
        // filename is correct as-is.
        actions.copyAsOverride(msg.sourcePlugin, msg.targetPlugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE) {
        actions.removeOverride(msg.plugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER) {
        // #272: addMaster resolves through overrideMap (the live pending-aware masters list).
        actions.addMaster(columnKey(msg.plugin, msg.origin), msg.newMaster);
      }
    };
    // Issue #227: the array-element/array-parent menu's four broadcasts — same self-filter
    // shape as handleColumnHeaderMessage above (formKey, no changeId), split into its own
    // function for the same "don't balloon one branching function" reason.
    const isArrayOpMessage = (msg: ExtensionToWebview) => (
      msg.type === EXTENSION_TO_WEBVIEW.ARRAY_ADD || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_REMOVE
      || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP || msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN
    );
    const handleArrayOpMessage = (msg: ExtensionToWebview) => {
      if (!isArrayOpMessage(msg)) { handleColumnHeaderMessage(msg); return; }
      const actions = arrayOpActionsRef.current;
      if (msg.formKey !== actions.formKey) return;
      // #272: every array op resolves its current array through overrideMap/the synthesized
      // diff tree (both ColumnKey-keyed), so the broadcast's plugin+origin are combined here.
      if (msg.type === EXTENSION_TO_WEBVIEW.ARRAY_ADD) {
        actions.add(columnKey(msg.plugin, msg.origin), msg.fieldName);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ARRAY_REMOVE) {
        actions.remove(columnKey(msg.plugin, msg.origin), msg.fieldName, msg.index);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_UP) {
        actions.moveUp(columnKey(msg.plugin, msg.origin), msg.fieldName, msg.index);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN) {
        actions.moveDown(columnKey(msg.plugin, msg.origin), msg.fieldName, msg.index);
      }
    };
    // Issue #231: VMAD's own structural-op menu broadcasts — same self-filter shape as
    // handleArrayOpMessage above, split into its own function for the same reason.
    const isVmadOpMessage = (msg: ExtensionToWebview) => (
      msg.type === EXTENSION_TO_WEBVIEW.VMAD_ADD_SCRIPT || msg.type === EXTENSION_TO_WEBVIEW.VMAD_REMOVE_SCRIPT
      || msg.type === EXTENSION_TO_WEBVIEW.VMAD_REMOVE_PROPERTY || msg.type === EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY
      || msg.type === EXTENSION_TO_WEBVIEW.VMAD_SET_SCRIPT_FLAGS || msg.type === EXTENSION_TO_WEBVIEW.VMAD_SET_PROPERTY_FLAGS
    );
    // Issue #231 (review): split out of the dispatch chain below purely to keep its own
    // cognitive-complexity budget from tipping over now that Set Script/Property Flags make it
    // six branches instead of four.
    const dispatchVmadOpMessage = (actions: typeof vmadOpActionsRef.current, msg: ExtensionToWebview) => {
      if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_ADD_SCRIPT) {
        actions.addScript(msg.plugin, msg.name);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_REMOVE_SCRIPT) {
        actions.removeScript(msg.plugin, msg.scriptName);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_REMOVE_PROPERTY) {
        actions.removeProperty(msg.plugin, msg.scriptName, msg.propName);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY) {
        // #272: openAddProperty seeds addPropertyTarget, react state carrying column identity
        // across renders (per ADR-0036's own ruling) — the other five VMAD ops below forward
        // straight through to handleVmadStructOp with no local lookup, so their bare plugin
        // filename is correct as-is (write-target DTOs don't carry origin).
        actions.openAddProperty(columnKey(msg.plugin, msg.origin), msg.scriptName);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_SET_SCRIPT_FLAGS) {
        actions.setScriptFlags(msg.plugin, msg.scriptName, msg.flags);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.VMAD_SET_PROPERTY_FLAGS) {
        actions.setPropertyFlags(msg.plugin, msg.scriptName, msg.propName, msg.flags);
      }
    };
    const handleVmadOpMessage = (msg: ExtensionToWebview) => {
      if (!isVmadOpMessage(msg)) { handleArrayOpMessage(msg); return; }
      const actions = vmadOpActionsRef.current;
      if (msg.formKey !== actions.formKey) return;
      dispatchVmadOpMessage(actions, msg);
    };
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebview;
      if (msg.type === EXTENSION_TO_WEBVIEW.LOAD_RECORD) {
        if (msg.formKey !== prevFormKeyRef.current) {
          // formKey will change → [formKey] effect will fire; skip it.
          skipNextRefreshEffect.current = true;
        }
        setFormKey(msg.formKey);
        setResult(null);
        setAllChanges([]);
        setError(null);
        setActionError(null);
        setFocusedCell(null);
        void refreshRef.current(msg.formKey);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP) {
        const { allChanges: changes, saveGroup } = pendingCellActionsRef.current;
        if (changes.some(c => c.id === msg.changeId)) saveGroup(msg.changeId);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP) {
        const { allChanges: changes, revertGroup } = pendingCellActionsRef.current;
        if (changes.some(c => c.id === msg.changeId)) revertGroup(msg.changeId);
      } else {
        handleVmadOpMessage(msg);
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

  async function handleEdit(plugin: string, fieldName: string, value: unknown) {
    if (await stageChange(plugin, { [fieldName]: value })) {
      // Issue #200: covers disk-cell click-to-edit, VMAD/Condition leaf edits, array
      // add/remove/move, and a successful drag-drop copy uniformly — every one of them calls
      // handleEdit, with no source-specific branching, so one log call covers them all. Logged
      // here rather than inside stageChange itself, which stays a silent low-level primitive
      // shared with handleVmadStructOp's own separate log call.
      logAction('debug', `Staged field edit on ${plugin}: ${fieldName} (record ${formKey})`);
    }
  }

  // VMAD structural ops (phase 13.8): stage an op payload under a single change type.
  async function handleVmadStructOp(plugin: string, vmadPath: string, op: unknown) {
    if (await stageChange(plugin, { [vmadPath]: op }, 'vmad_struct_op')) {
      logAction('debug', `Staged vmad_struct_op on ${plugin}: ${vmadPath} (record ${formKey})`);
    }
  }

  async function stageChange(plugin: string, fields: Record<string, unknown>, changeType?: string): Promise<boolean> {
    setActionError(null);
    const result = await client.save(formKey, plugin, fields, changeType);
    if (!result.ok) {
      if (result.status === 409) {
        const detail = typeof result.error.detail === 'string' ? result.error.detail : '';
        setActionError(detail.toLowerCase().includes('group') ? detail : 'Plugin is read-only');
      } else if (result.status === 422) {
        // #147: single documented envelope (PatchRecordValidationError) — fieldErrors is non-null
        // for reference/append-only/type-mismatch/null-not-allowed failures, detail is non-null for
        // everything else (e.g. ESL-ineligible, read-only fields). Never both. #163: 422 is the
        // one status this operation's typed error union resolves to PatchRecordValidationError
        // (409/404 resolve to ProblemDetails instead) — the cast below just names what the status
        // code already guarantees, same as the old body-shape check it replaces.
        const body = result.error as PatchRecordValidationError;
        if (body.fieldErrors && body.fieldErrors.length > 0) {
          setActionError(body.fieldErrors.map(e => {
            const path = e.fieldPath ?? '?';
            if (e.reason === 'not_in_session') return `${path}: reference not found in session`;
            if (e.reason === 'not_append_only') return `${path}: masters can only be appended to, not reordered or removed`;
            if (e.reason === 'type_mismatch') return `${path}: expected ${(e.expectedTypes ?? []).join('/')}`;
            if (e.reason === 'null_not_allowed') return `${path}: cannot be null`;
            return `${path}: ${e.reason ?? 'invalid'}`;
          }).join('; '));
        } else if (typeof body.detail === 'string') {
          setActionError(body.detail);
        } else {
          setActionError('Invalid reference');
        }
      } else {
        setActionError(`Error: ${errorText(result.error)}`);
      }
      return false;
    }
    notifyPendingChanged();
    await refresh(formKey);
    return true;
  }

  // Issue #139: Revert Group (right-click menu only, ADR-0033) reverts the change's whole
  // component (ADR-0029). A group of one reverts straight away — the common case, exactly
  // "revert this field"; a multi-member group confirms first, listing what travels with it,
  // rather than firing the backend's 409 for a partial group revert (ADR-0028). The member
  // count comes from GET /changes for this change's component; a failed read yields [] and
  // takes the no-confirmation path, never a raw 409.
  // Issue #212: the confirmation itself is now a native modal warning (confirmRevertGroup) —
  // the deleted RevertGroupConfirm's per-member "recordType / formKey · fieldPath" listing is
  // composed here into the modal's detail text, since the webview already holds these members
  // from groupMembers() above (no extension-host fetch needed, unlike the FormKey/condition-
  // function QuickPick bridges).
  async function handleRevertGroup(changeId: string) {
    setActionError(null);
    const members = await client.groupMembers(changeId);
    if (members.length > 1) {
      const detail = members.map(m => `${m.recordType ?? ''} / ${m.formKey ?? ''} · ${m.fieldPath ?? ''}`).join('\n');
      const confirmed = await confirmRevertGroup(detail);
      if (!confirmed) return;
    }
    await revertGroup(changeId);
  }

  async function revertGroup(changeId: string) {
    setActionError(null);
    const result = await client.revertGroup(changeId);
    if (!result.ok) {
      const detail = typeof result.error.detail === 'string' ? result.error.detail : '';
      setActionError(detail || `Revert failed: ${errorText(result.error)}`);
      return;
    }
    // Issue #200: looked up before refresh() replaces allChanges.
    const identity = changeIdentity(allChanges.find(c => c.id === changeId));
    logAction('info', `Reverted group ${changeId}${identity}`);
    notifyPendingChanged();
    await refresh(formKey);
  }

  // Issue #139: save the change's whole component (ADR-0029). A save can return HTTP 200 yet
  // leave some fields unwritten, or commit to disk but fail the post-commit reindex — both are
  // ADR-0026 integrity outcomes surfaced from what SaveGroupResponse reports, worded to match
  // severity: a partial save reads as a failure with the plugins named and the group re-queued;
  // a stale reindex reads as a completed-save warning to reload, never as a failure.
  async function handleSaveGroup(changeId: string) {
    setActionError(null);
    const result = await client.saveGroup(changeId);
    if (!result.ok) {
      setActionError(`Save failed: ${errorText(result.error)}`);
      return;
    }
    // #163: byPlugin is nullable on the generated SaveGroupResponse; partialSaveMessage's own
    // SaveOutcome type isn't, so normalize null to the same undefined it already treats as
    // "nothing to summarize".
    const messages = [
      partialSaveMessage(result.data.byPlugin ?? undefined),
      staleIndexMessage(result.data.reindexFailure),
    ].filter(Boolean);
    setActionError(messages.length > 0 ? messages.join(' ') : null);
    // Issue #200: looked up before refresh() replaces allChanges.
    const identity = changeIdentity(allChanges.find(c => c.id === changeId));
    logAction('info', `Saved group ${changeId}${identity}`);
    notifyPendingChanged();
    await refresh(formKey);
  }

  // Issue #208: keeps pendingCellActionsRef current every render so the mount-only message
  // listener's broadcast branches (above) always self-filter against this render's allChanges
  // and call this render's handleSaveGroup/handleRevertGroup — not whichever closure existed
  // when the listener was first attached.
  useLayoutEffect(() => {
    pendingCellActionsRef.current = {
      allChanges,
      saveGroup: id => { void handleSaveGroup(id); },
      revertGroup: id => { void handleRevertGroup(id); },
    };
  });

  // Issue #202: sourcePlugin is the right-clicked column (not necessarily the winner) — forwarded
  // to copyTo unchanged; the backend (EditOrchestrator.CopyRecordTo) decides whose fields actually
  // get copied. Logged on success (#200 deliberately deferred this action's own log call here).
  async function handleCopyTo(sourcePlugin: string, targetPlugin: string) {
    setActionError(null);
    try {
      const result = await client.copyTo(formKey, targetPlugin, sourcePlugin);
      if (!result.ok) {
        setActionError(result.status === 409 ? 'Plugin is read-only' : `Copy failed: ${errorText(result.error)}`);
        return;
      }
      logAction('info', `Copied ${sourcePlugin} as override into ${targetPlugin} (record ${formKey})`);
      notifyPendingChanged();
      await refresh(formKey);
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  // Issue #3: "Remove" (renamed from "Remove Override" in #177) — stages a delete of this
  // plugin's override of the current record (Phase 10's DeleteRecords endpoint, reached here
  // via the same raw-fetch pattern as handleCopyTo — the webview never routes through
  // SessionController/ApiClient).
  async function handleRemoveOverride(plugin: string) {
    setActionError(null);
    try {
      const result = await client.removeOverride(formKey, plugin);
      if (!result.ok) {
        setActionError(result.status === 409 ? 'Plugin is read-only' : `Remove failed: ${errorText(result.error)}`);
        return;
      }
      logAction('info', `Removed override of ${plugin} (record ${formKey})`);
      notifyPendingChanged();
      await refresh(formKey);
    } catch (e) {
      setActionError(`Remove failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  function handleOpen(fk: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: fk });
  }

  function handleCellDragStart(fieldName: string, value: unknown, sourcePlugin: ColumnKey) {
    dragPayloadRef.current = { fieldName, value, sourcePlugin };
  }

  // Issue #3: target must be an editable plugin — reject a drop onto an immutable column as a
  // silent no-op (no PATCH attempt), distinct from typed edits into a read-only cell, which are
  // attempted and surfaced as a 409 by stageChange. Also guards against dropping onto an
  // unrelated field's row (payload fieldName must match the row it's dropped on).
  function handleCellDrop(fieldName: string, targetPlugin: ColumnKey, applyValue: (value: unknown) => void) {
    const payload = dragPayloadRef.current;
    dragPayloadRef.current = null;
    if (!payload || payload.fieldName !== fieldName) return;
    // Issue #206: dropping a value back onto the exact cell it was dragged from is a no-op
    // gesture, not an edit or a rejection — silent, same as the fieldName-mismatch guard above,
    // and checked before the immutable-column guard below so a self-drop onto an immutable
    // column's own cell stays silent too rather than logging a WARN it doesn't deserve.
    if (payload.sourcePlugin === targetPlugin) return;
    if (immutableSet.has(targetPlugin)) {
      // Issue #200: was a silent no-op — the system correctly refused this, so it's a WARN,
      // not silence (#198's policy). Logs the ColumnKey, not a decomposed real filename — this
      // function is declared before overrideMap's own useMemo in source order, and closing over
      // it here purely for a log string isn't worth the forward reference.
      logAction('warn', `Rejected drop of '${fieldName}' onto immutable plugin ${targetPlugin}`);
      return;
    }
    applyValue(payload.value);
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
  // (`!isHeaderRecord`), computed here too since these two hooks run before `isHeaderRecord`'s own
  // declaration further down (hooks can't follow the early-return guards that precede it).
  const isHeaderRecordForVmad = formKey.startsWith('000000:');

  // Issue #231: VMAD and Conditions map into the same node shape (FieldDiff + FieldMetadata) the
  // ordinary reflected fields already use — vmadTreeAdapter.ts/conditionTreeAdapter.ts are pure
  // functions with no rendering of their own, so their rows flow through the exact same
  // buildRows/DiffRow path below as any other field, and there is no VmadSection/ConditionSection
  // left to render separately.
  const vmadTree = useMemo(
    () => (isHeaderRecordForVmad || !result?.hasVmad) ? { diffs: [], metaMap: {} } : buildVmadRows(result.vmad),
    [result, isHeaderRecordForVmad],
  );
  const conditionTree = useMemo(
    () => isHeaderRecordForVmad ? { diffs: [], metaMap: {} } : buildConditionRows(result?.conditions, runOnTargets),
    [result, isHeaderRecordForVmad, runOnTargets],
  );

  const fieldMetaMap = useMemo((): Record<string, FieldMetadata> => {
    const map: Record<string, FieldMetadata> = {};
    for (const o of result?.overrides ?? []) {
      for (const fv of o.fields) {
        if (!map[fv.metadata.name]) map[fv.metadata.name] = fv.metadata;
      }
    }
    Object.assign(map, vmadTree.metaMap, conditionTree.metaMap);
    return map;
  }, [result, vmadTree, conditionTree]);

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

  // Issue #3: "Copy as New Record" — a fresh FormKey in the target plugin, not an override of
  // this one. CreateRecord's TemplateFormKey only templates from the overall winner (EditOrchestrator
  // .CreateRecordCore calls _query.GetRecord(formKey), winner-only), which isn't necessarily this
  // source column's plugin — so instead of relying on TemplateFormKey, create a blank record of the
  // right type, then PATCH every source-column field onto it.
  async function handleCopyAsNewRecord(sourceKey: ColumnKey, targetPlugin: string) {
    const source = overrideMap[sourceKey];
    if (!source) return;
    const sourcePlugin = source.plugin;
    setActionError(null);
    try {
      const createResult = await client.createRecord(targetPlugin, source.recordType);
      if (!createResult.ok) {
        setActionError(createResult.status === 409 ? 'Plugin is read-only' : `Copy failed: ${errorText(createResult.error)}`);
        return;
      }
      // #163: formKey is nullable on the generated CreateRecordResult; the backend always
      // populates it on a 200 (same trust the old `.json() as { formKey: string }` cast placed).
      const newFormKey = createResult.data.formKey as string;
      const fields: Record<string, unknown> = {};
      for (const fv of source.fields) fields[fv.metadata.name] = fv.value;
      const patchResult = await client.save(newFormKey, targetPlugin, fields);
      if (!patchResult.ok) {
        setActionError(`Copy failed: ${errorText(patchResult.error)}`);
        return;
      }
      logAction('info', `Copied ${sourcePlugin} (record ${formKey}) as new record ${newFormKey} on ${targetPlugin}`);
      notifyPendingChanged();
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  // Issue #209: "Add Master…" moved from PluginHeader's own inline dropdown (deleted) to the
  // column-header's native menu — the append-to-masters logic (previously the JSX-inline
  // `onAddMaster` lambda) lives here now instead, using the live (pending-aware) masters list at
  // broadcast-receipt time rather than whatever the extension host's QuickPick candidate list
  // was built from (it can only have seen a snapshot carried in data-vscode-context).
  function handleAddMaster(key: ColumnKey, newMaster: string) {
    const override = overrideMap[key];
    if (!override) return;
    void handleEdit(override.plugin, 'masters', [...currentMasters(override), newMaster]);
  }

  // Issue #209: keeps columnHeaderActionsRef current every render, mirroring
  // pendingCellActionsRef below — the mount-only message listener's column-header branches
  // always need this render's formKey/overrideMap-derived handlers, not whatever closed over
  // pendingCellActionsRef when the listener was first attached.
  useLayoutEffect(() => {
    columnHeaderActionsRef.current = {
      formKey,
      copyAsNewRecord: (sourcePlugin, targetPlugin) => { void handleCopyAsNewRecord(sourcePlugin, targetPlugin); },
      copyAsOverride: (sourcePlugin, targetPlugin) => { void handleCopyTo(sourcePlugin, targetPlugin); },
      removeOverride: plugin => { void handleRemoveOverride(plugin); },
      addMaster: handleAddMaster,
    };
  });

  // Issue #227: the array-element/array-parent menu's broadcast target — a generic version of
  // the per-row `resolveCurrentArr` closure DiffRow's render loop already builds (pending-over-
  // disk merge for one plugin's array), needed here because the broadcast arrives asynchronously
  // in a mount-effect message handler, not inside a row's render, so there is no row closure to
  // reuse. Same pending-aware merge either way — an in-flight pending array wins over disk.
  //
  // Issue #231: `fieldName` here is the broadcast's own `ArrayParentContext`/`ArrayElementContext`
  // payload, which is `context.rootField` at the row that emitted it — an ordinary field's own
  // name, but a VMAD/Condition array's own wire path. The disk half of the merge has to follow
  // that split too: an ordinary field's disk value lives in `overrideMap[plugin].fields`
  // (unchanged), but a VMAD/Condition row was never a reflected field at all — its disk value
  // lives in the synthesized diff tree instead (`vmadTree.diffs`/`conditionTree.diffs`, keyed by
  // `wirePath`), which `findDiffByWirePath` searches. Getting this wrong silently replaces the
  // *whole* array with the new/edited element alone — the pre-fix bug this comment replaces.
  function resolveCurrentArrayFor(key: ColumnKey, fieldName: string): unknown[] {
    const ordinaryDisk = overrideMap[key]?.fields.find(f => f.metadata.name === fieldName)?.value as unknown[] | undefined;
    const synthesizedDisk = ordinaryDisk === undefined
      ? findDiffByWirePath([...vmadTree.diffs, ...conditionTree.diffs], fieldName)?.values[key] as unknown[] | undefined
      : undefined;
    const disk = ordinaryDisk ?? synthesizedDisk;
    const pending = overrideMap[key]?.pendingFields?.[fieldName] as unknown[] | undefined;
    return pending ?? disk ?? [];
  }

  // Issue #227: Add — appends a default-valued element derived from the array's own elementType
  // (defaultElementValue), same as #142's inline "＋" button used to. A no-op if the field isn't
  // a known array (defends against a stale broadcast racing a record navigation).
  //
  // Issue #231 (review): `fieldMetaMap`'s own flat lookup only ever finds a *top-level* entry —
  // enough for an ordinary field, the VMAD wrapper itself, and a Condition list (always itself
  // top-level) — but not a VMAD array-of-scalars property nested below a script, which has no flat
  // entry of its own. findMetaByWirePath falls back to walking down from vmadTree's/
  // conditionTree's own top-level nodes for that case.
  // #272 / ADR-0036: `key` resolves this row's own array via overrideMap/the synthesized diff
  // tree (both ColumnKey-keyed); the actual PATCH still needs the real plugin filename
  // (write-target DTOs deliberately don't carry origin — the server resolves it), decomposed via
  // overrideMap[key].plugin right here rather than ever parsed out of `key` itself. A key that no
  // longer resolves (a stale broadcast racing a record navigation) is a no-op, same convention
  // the reference-equality skips below already use.
  function handleArrayAdd(key: ColumnKey, fieldName: string) {
    const meta = fieldMetaMap[fieldName]
      ?? findMetaByWirePath([...vmadTree.diffs, ...conditionTree.diffs], { ...vmadTree.metaMap, ...conditionTree.metaMap }, fieldName);
    const elementType = meta?.type === 'array' ? meta.elementType : undefined;
    const realPlugin = overrideMap[key]?.plugin;
    if (!elementType || realPlugin === undefined) return;
    void handleEdit(realPlugin, fieldName, appendArrayElement(resolveCurrentArrayFor(key, fieldName), defaultElementValue(elementType)));
  }

  // Issue #168 (review): mirrors handleArrayMove's own reference-equality skip below —
  // removeArrayElement now returns the same array reference, unchanged, for an out-of-range index
  // (this plugin doesn't have an element at that position at all, e.g. a stale broadcast or a row
  // that only exists because a sibling plugin has more elements) — restaging is skipped rather
  // than firing a no-op save.
  function handleArrayRemove(key: ColumnKey, fieldName: string, index: number) {
    const current = resolveCurrentArrayFor(key, fieldName);
    const next = removeArrayElement(current, index);
    const realPlugin = overrideMap[key]?.plugin;
    if (next !== current && realPlugin !== undefined) void handleEdit(realPlugin, fieldName, next);
  }

  // Issue #227: shared by Move Up/Move Down — moveArrayElement itself already no-ops (returns
  // the same array reference) at a boundary, so restaging is skipped rather than firing a no-op
  // save when a stale broadcast (or a race with a concurrent edit shrinking the array) lands on
  // an element that can no longer move that direction.
  function handleArrayMove(key: ColumnKey, fieldName: string, index: number, direction: -1 | 1) {
    const current = resolveCurrentArrayFor(key, fieldName);
    const next = moveArrayElement(current, index, direction);
    const realPlugin = overrideMap[key]?.plugin;
    if (next !== current && realPlugin !== undefined) void handleEdit(realPlugin, fieldName, next);
  }

  // Issue #227: keeps arrayOpActionsRef current every render, mirroring columnHeaderActionsRef
  // just above — the mount-only message listener's array-op branch always needs this render's
  // formKey/overrideMap/fieldMetaMap-derived handlers, not whatever closed over the ref when the
  // listener was first attached.
  useLayoutEffect(() => {
    arrayOpActionsRef.current = {
      formKey,
      add: handleArrayAdd,
      remove: handleArrayRemove,
      moveUp: (plugin, fieldName, index) => handleArrayMove(plugin, fieldName, index, -1),
      moveDown: (plugin, fieldName, index) => handleArrayMove(plugin, fieldName, index, 1),
    };
  });

  // Issue #231: VMAD's own structural-op commands — mirrors VmadScriptOps'/VmadPropertyOps'
  // deleted AddScriptButton/RemoveScriptButton/RemovePropertyButton onClick bodies exactly, just
  // reached from the right-click menu's broadcast instead of an inline button's own handler.
  function vmadAddScript(plugin: string, name: string) {
    void handleVmadStructOp(plugin, `VMAD\\${name}`, { op: 'add_script', name, flags: 'Local', properties: [] });
  }
  function vmadRemoveScript(plugin: string, scriptName: string) {
    void handleVmadStructOp(plugin, `VMAD\\${scriptName}`, { op: 'remove_script' });
  }
  function vmadRemoveProperty(plugin: string, scriptName: string, propName: string) {
    void handleVmadStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'remove_property' });
  }
  // Issue #231 (review): restores Set Script Flags/Set Property Flags — dropped when the deleted
  // ScriptFlagsControl/PropertyFlagsControl's always-visible `<select>`s went with VmadSection,
  // with no working replacement (AC7 regression) until this. Same `set_flags` op the deleted
  // controls already staged, now reached from the right-click menu instead of an inline control.
  function vmadSetScriptFlags(plugin: string, scriptName: string, flags: string) {
    void handleVmadStructOp(plugin, `VMAD\\${scriptName}`, { op: 'set_flags', flags });
  }
  function vmadSetPropertyFlags(plugin: string, scriptName: string, propName: string, flags: string) {
    void handleVmadStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'set_flags', flags });
  }

  // Issue #231: keeps vmadOpActionsRef current every render, mirroring arrayOpActionsRef above.
  useLayoutEffect(() => {
    vmadOpActionsRef.current = {
      formKey,
      addScript: vmadAddScript,
      removeScript: vmadRemoveScript,
      removeProperty: vmadRemoveProperty,
      openAddProperty: (plugin, scriptName) => setAddPropertyTarget({ plugin, scriptName }),
      setScriptFlags: vmadSetScriptFlags,
      setPropertyFlags: vmadSetPropertyFlags,
    };
  });

  const columns = useMemo(
    () => result ? buildColumns(result.overrides, immutableSet) : [],
    [result, immutableSet],
  );

  // #272 / ADR-0036: the plugin half of this compound key is built via columnKey(), not the bare
  // `c.plugin` — a staged change is attributed to its column's compound identity end to end, from
  // cell to pending change. The key as a whole (`${ColumnKey}:${fieldPath}`) isn't itself a pure
  // ColumnKey, so this map's declared type stays Record<string, PendingChange>.
  const pendingChangeMap = useMemo((): Record<string, PendingChange> => {
    const map: Record<string, PendingChange> = {};
    for (const c of allChanges) map[`${columnKey(c.plugin, c.origin)}:${c.fieldPath}`] = c;
    return map;
  }, [allChanges]);

  // Issue #175: pinned to the viewport (not the document) so the panel's height is always
  // bounded, regardless of how tall the compare grid's content gets — the flex-column layout
  // below then gives the grid its own scroll region instead of letting the whole document grow
  // to fit the table. `boxSizing: border-box` keeps the padding inside that viewport bound.
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
  // Issue #86: the header record lives at the synthetic FormKey "000000:<plugin>" (CONTEXT.md);
  // only it has an editable masters field.
  const isHeaderRecord = formKey.startsWith('000000:');

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
    rootField: string, rootDiff: FieldDiff, rowKey: string, arrayEdit?: ArrayEditControls,
  ): React.ReactNode[] {
    const hasChildren = (diff.children?.length ?? 0) > 0;
    const isExpanded = expandedStructs.has(rowKey);

    // Issue #142/#231: pending-over-disk value of the *root* this row restages into, generalized
    // from resolveCurrentArr/the struct-child merge above to any depth — setAtPath/getAtPath
    // handle walking from here down to this row's own path themselves.
    // #272 / ADR-0036: keyed by ColumnKey — overrideMap and rootDiff.values (the wire's own
    // per-column dictionary, ColumnKey.Of-keyed since the backend's B3) both require it.
    const currentRootValue = (key: ColumnKey): unknown => {
      const pending = overrideMap[key]?.pendingFields?.[rootField];
      return pending !== undefined ? pending : rootDiff.values[key];
    };
    // Issue #231: `rootDiff.commitOverride`, when present, replaces the generic setAtPath for
    // this whole subtree — the one escape hatch for a wire value whose shape isn't a plain nested
    // object/array (VMAD's Struct/ArrayOfStruct properties, whose backend wire format is its own
    // raw node tree, unchanged by this issue). Absent for every ordinary field, every Condition
    // field, and VMAD's own scalar/object/array-of-scalar properties — all of those produce the
    // right shape via setAtPath already, so this is a no-op fallback for them, not a new branch
    // they have to reason about. #272: decomposes to the real plugin filename (overrideMap[key]
    // .plugin) right before handleEdit — write-target DTOs don't carry origin (the server
    // resolves it), and a ColumnKey is never parsed back apart to get one out.
    const commitHere = (key: ColumnKey, value: unknown) => {
      const current = currentRootValue(key);
      const next = rootDiff.commitOverride ? rootDiff.commitOverride(current, path, value) : setAtPath(current, path, value);
      const realPlugin = overrideMap[key]?.plugin;
      if (realPlugin === undefined) return;
      void handleEdit(realPlugin, rootField, next);
    };
    const currentArrayHere = (key: ColumnKey): unknown[] => {
      const v = getAtPath(currentRootValue(key), path);
      return Array.isArray(v) ? v : [];
    };

    // Issue #142: "＋" on an array's own row — absent for sortable arrays and non-array fields,
    // same gate as before, now evaluated at every depth rather than only at the top level.
    // Issue #231: also absent when this row has a `commitOverride` (a raw-node wire format) whose
    // elementType carries no explicit `defaultValue` — `defaultElementValue`'s generic per-field
    // struct default doesn't know that format either, so appending one would stage a
    // wrong-shaped element (VMAD's structList, whose own element default has no analogue yet —
    // a known, deliberately scoped gap, see the record-editor spec). A condition list is the
    // proof this isn't a blanket "commitOverride disables add" rule: it has both a
    // `commitOverride` (compacting the sparse array) *and* an explicit `elementType.defaultValue`
    // (`defaultCondition()`), so its own Add stays fully enabled.
    const onArrayAdd = meta?.type === 'array' && meta.elementType != null && meta.elementType.isSortable !== true
      && (!rootDiff.commitOverride || meta.elementType.defaultValue !== undefined)
      ? (key: ColumnKey) => commitHere(key, appendArrayElement(currentArrayHere(key), defaultElementValue(meta.elementType!)))
      : undefined;

    // Issue #231: builds this row's own VMAD structural-op data-vscode-context per plugin —
    // `diff.vmadOpKind` is the adapter's marker (vmadTreeAdapter.ts); the script/property identity
    // itself comes from this row's own fieldName ("scripts"/"script") or its wirePath
    // (parseVmadPath, "property" — its own wirePath is always `VMAD\Script\Prop`, set by the same
    // adapter). Absent for every non-VMAD row, so DiffRow's own gate (structOpContextFor?.(...))
    // simply has nothing to call. #272: takes the column's real override `o` (plugin + origin as
    // parallel fields) — the vmad*Context builders need the two separate strings, and
    // diff.values' own per-column lookup below needs the ColumnKey derived from them.
    const structOpContextFor = ((): ((o: CompareOverride) => object | undefined) | undefined => {
      if (diff.vmadOpKind === 'scripts') return o => vmadScriptsContext(formKey, o.plugin, o.origin ?? 'Data');
      // Issue #231 (review): Set Script Flags' own QuickPick seed — this script row's own
      // `values[key]` (buildScript sets it to `s.flags`, VmadScriptDiff's per-column flag).
      if (diff.vmadOpKind === 'script') {
        return o => vmadScriptContext(
          formKey, o.plugin, o.origin ?? 'Data', diff.fieldName,
          (diff.values[columnKey(o.plugin, o.origin)] as string | undefined) ?? null,
        );
      }
      if (diff.vmadOpKind === 'property') {
        const parsed = parseVmadPath(rootField);
        if (!parsed) return undefined;
        return o => vmadPropertyContext(formKey, o.plugin, o.origin ?? 'Data', parsed.script, parsed.prop);
      }
      return undefined;
    })();

    const rows: React.ReactNode[] = [
      <DiffRow
        key={rowKey}
        formKey={formKey}
        recordLabel={title}
        diff={diff}
        columns={columns}
        overrideMap={overrideMap}
        fieldMetaMap={fieldMetaMap}
        immutableSet={immutableSet}
        pendingChangeMap={pendingChangeMap}
        collapsedColumns={collapsedColumns}
        onCellDragStart={handleCellDragStart}
        onCellDrop={handleCellDrop}
        onOpen={handleOpen}
        onEdit={(plugin, _key, value) => commitHere(plugin, value)}
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
        arrayEdit={arrayEdit}
        onArrayAdd={onArrayAdd}
        structOpContextFor={structOpContextFor}
      />,
    ];

    if (!hasChildren || !isExpanded || !meta) return rows;

    // Issue #231: split out of buildRows purely to keep its own branching under the repo's
    // cognitive-complexity budget — an array child restages through this array's own
    // currentArrayHere/commitHere (its move-up/move-down/remove controls, absent for a sortable
    // element whose order/arity isn't user-editable), a struct child through the plain
    // member-name path every other struct field already uses.
    for (const child of diff.children ?? []) {
      const childRowKey = `${rowKey}.${child.fieldName}`;
      if (meta.type === 'array' && meta.elementType) {
        rows.push(...buildArrayElementRows(child, meta.elementType, path, rootField, rootDiff, childRowKey, { currentArray: currentArrayHere, commit: commitHere }));
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
    childRowKey: string, arrayOps: { currentArray: (key: ColumnKey) => unknown[]; commit: (key: ColumnKey, value: unknown) => void },
  ): React.ReactNode[] {
    const seg: PathSegment = elementMeta.isSortable
      ? { kind: 'sortKey', key: child.fieldName }
      : { kind: 'index', index: parseElementIndex(child.fieldName) };
    const childArrayEdit: ArrayEditControls | undefined = elementMeta.isSortable !== true ? {
      currentArray: arrayOps.currentArray,
      index: parseElementIndex(child.fieldName),
      onArrayEdit: (plugin, value) => arrayOps.commit(plugin, value),
    } : undefined;
    return buildRows(child, elementMeta, [...arrayPath, seg], rootField, rootDiff, childRowKey, childArrayEdit);
  }

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
      {/* Issue #231: Add Property's own dialog — opened by the right-click menu's
          VMAD_OPEN_ADD_PROPERTY broadcast rather than an inline "+prop" button, but otherwise
          unchanged from #229's own exception (three fields at once, a webview modal not a
          QuickPick chain). Confirm stages through the same handleVmadStructOp every other VMAD
          structural op uses. */}
      {addPropertyTarget && (
        <AddPropertyDialog
          onCancel={() => setAddPropertyTarget(null)}
          onConfirm={({ name, type, value }) => {
            const { plugin: key, scriptName } = addPropertyTarget;
            setAddPropertyTarget(null);
            const realPlugin = overrideMap[key]?.plugin;
            if (realPlugin === undefined) return;
            void handleVmadStructOp(realPlugin, `VMAD\\${scriptName}\\${name}`, { op: 'add_property', type, name, flags: 'Edited', value });
          }}
        />
      )}
      {actionError && (
        <div style={{ flex: '0 0 auto', marginBottom: 8, fontSize: '11px', color: 'var(--vscode-errorForeground, #f88)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-errorBorder, #f88)', borderRadius: 2 }}>
          {actionError}
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
                if (col.kind === 'disk') {
                  // #272 / ADR-0036: collapsedColumns/immutableSet are keyed by col.key
                  // (ColumnKey), not the bare plugin filename — two same-filename columns must
                  // collapse/read-only independently. columnHeaderContext still gets the real
                  // plugin+origin pair (col.override.plugin/.origin), never the compound key.
                  const isCollapsed = collapsedColumns.has(col.key);
                  const isImmutable = immutableSet.has(col.key);
                  return (
                    <th
                      key={`disk:${col.key}`}
                      style={{ ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px', backgroundColor: getHeaderBg(col.override.conflictThis) }}
                      // Issue #209: the column-header menu (Copy as Override… / Copy as New
                      // Record / Remove / Add Master) is VS Code's own `webview/context` menu
                      // now — no `onContextMenu`/`preventDefault()` here any more, same
                      // migration switch as #208's pending cells.
                      data-vscode-context={columnHeaderContext(
                        formKey, col.override.plugin, col.override.origin ?? 'Data', isImmutable, isHeaderRecord, currentMasters(col.override),
                      )}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={isImmutable}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.key)}
                      />
                    </th>
                  );
                }
                return (
                  <th key={`pending:${col.key}`} style={{ ...baseCell, fontWeight: 400, textAlign: 'left', minWidth: '160px', fontStyle: 'italic', opacity: 0.7 }}>
                    <div>Pending</div>
                    <div style={{ fontSize: '11px', opacity: 0.6 }}>{col.plugin}</div>
                  </th>
                );
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
