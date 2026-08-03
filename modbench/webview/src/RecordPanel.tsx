import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { confirmRevertGroup } from './nativeBridge';
import { DiffRow, type FocusedCell } from './DiffRow';
import { partialSaveMessage, staleIndexMessage } from '../../src/medit/saveClassification';
import type { ReindexFailure, SaveResult } from '../../src/medit/saveClassification';
import { buildColumns, columnHeaderContext, currentMasters, defaultElementValue, parseElementIndex, updateArrayAtKey } from './recordUtils';
import { mono, fg, baseCell, headerCell, getConflictBg } from './gridStyles';
import { VmadSection } from './VmadSection';
import { ConditionSection } from './ConditionSection';
import type { CompareOverride, CompareResult, ConflictThis, FieldMetadata, PatchRecordValidationError, PendingChange } from './types';
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

// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordSessionClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [allChanges, setAllChanges] = useState<PendingChange[]>([]);
  const [immutableSet, setImmutableSet] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // Issue #222 / ADR-0034: the single source of truth for "which disk-column cell is focused,"
  // shared by every DiffRow instance so at most one cell across the field grid is ever focused at
  // once — DiffRow itself only knows about its own row. `rowKey` matches the string this
  // component already computes for each DiffRow's own `key=` below. Deliberately reset on
  // LOAD_RECORD (a different record has no "same cell" to keep focused — mirrors the
  // result/allChanges resets there) but left untouched by refresh() (same-record reload from
  // staging or a background refresh, where the focused cell should survive — AC3).
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  function handleFocusCell(rowKey: string, plugin: string) {
    setFocusedCell({ rowKey, plugin });
  }
  // Issue #3: collapsed plugin columns, keyed by plugin name. Deliberately NOT reset by the
  // LOAD_RECORD handler below — collapse state is meant to persist across record-to-record
  // navigation within the same panel session.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  // Issue #3: transient drag payload — doesn't need to trigger a re-render, so a ref rather
  // than state. Cleared on drop (successful or rejected). Issue #206: carries sourcePlugin too —
  // without it, handleCellDrop has no way to tell a drop back onto the same cell it came from
  // apart from a real cross-column copy.
  const dragPayloadRef = useRef<{ fieldName: string; value: unknown; sourcePlugin: string } | null>(null);

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
  // menu's five native commands (none of which carry a changeId — self-filtering is on `formKey`
  // instead, since these act on whichever record this panel currently has loaded, not a specific
  // pending change). copyAllToPending/copyAsNewRecord/copyTo/removeOverride are called with the
  // signatures their own handlers already take; addMaster is synthesized here since the inline
  // master picker that used to own it (PluginHeader) is gone — see currentMasters below.
  const columnHeaderActionsRef = useRef<{
    formKey: string;
    copyAllToPending: (sourcePlugin: string, targetPlugin: string) => void;
    copyAsNewRecord: (sourcePlugin: string, targetPlugin: string) => void;
    copyAsOverride: (targetPlugin: string) => void;
    removeOverride: (plugin: string) => void;
    addMaster: (plugin: string, newMaster: string) => void;
  }>({
    formKey: '', copyAllToPending: () => {}, copyAsNewRecord: () => {}, copyAsOverride: () => {},
    removeOverride: () => {}, addMaster: () => {},
  });

  // When the handler drives a new-formKey navigation it calls refresh directly,
  // so the [formKey] effect must skip to avoid a double request.
  const prevFormKeyRef = useRef(formKey);
  const skipNextRefreshEffect = useRef(false);

  // Listen for loadRecord messages from extension (panel reuse), plus #208's Save Group/Revert
  // Group and #209's column-header broadcasts from the native menu commands.
  useEffect(() => {
    // Issue #209: the column-header menu's five broadcasts, factored out of `handler` below so
    // its own branching doesn't balloon — each one only fires when this panel is the one showing
    // the mutated record (formKey self-filter, no changeId here).
    const handleColumnHeaderMessage = (msg: ExtensionToWebview) => {
      const actions = columnHeaderActionsRef.current;
      if (!('formKey' in msg) || msg.formKey !== actions.formKey) return;
      if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_ALL_TO_PENDING) {
        actions.copyAllToPending(msg.sourcePlugin, msg.targetPlugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD) {
        actions.copyAsNewRecord(msg.sourcePlugin, msg.targetPlugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE) {
        actions.copyAsOverride(msg.targetPlugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE) {
        actions.removeOverride(msg.plugin);
      } else if (msg.type === EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER) {
        actions.addMaster(msg.plugin, msg.newMaster);
      }
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
        handleColumnHeaderMessage(msg);
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
      // here rather than inside stageChange itself: handleCopyAllToPending ("Copy All to
      // Pending", #202's surface, deliberately untouched) also calls stageChange directly and
      // must stay silent.
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
    const resp = await client.save(formKey, plugin, fields, changeType);
    if (!resp.ok) {
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const detail = typeof body?.detail === 'string' ? body.detail : '';
        setActionError(detail.toLowerCase().includes('group') ? detail : 'Plugin is read-only');
      } else if (resp.status === 422) {
        // #147: single documented envelope (PatchRecordValidationError) — fieldErrors is non-null
        // for reference/append-only/type-mismatch/null-not-allowed failures, detail is non-null for
        // everything else (e.g. ESL-ineligible, read-only fields). Never both.
        const body = await resp.json().catch(() => null) as PatchRecordValidationError | null;
        if (body?.fieldErrors && body.fieldErrors.length > 0) {
          setActionError(body.fieldErrors.map(e => {
            const path = e.fieldPath ?? '?';
            if (e.reason === 'not_in_session') return `${path}: reference not found in session`;
            if (e.reason === 'not_append_only') return `${path}: masters can only be appended to, not reordered or removed`;
            if (e.reason === 'type_mismatch') return `${path}: expected ${(e.expectedTypes ?? []).join('/')}`;
            if (e.reason === 'null_not_allowed') return `${path}: cannot be null`;
            return `${path}: ${e.reason ?? 'invalid'}`;
          }).join('; '));
        } else if (typeof body?.detail === 'string') {
          setActionError(body.detail);
        } else {
          setActionError('Invalid reference');
        }
      } else {
        setActionError(`Error: ${resp.statusText}`);
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
    const resp = await client.revertGroup(changeId);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const detail = typeof body?.detail === 'string' ? body.detail : '';
      setActionError(detail || `Revert failed: ${resp.statusText}`);
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
    const resp = await client.saveGroup(changeId);
    if (!resp.ok) {
      setActionError(`Save failed: ${resp.statusText}`);
      return;
    }
    const body = await resp.json().catch(() => ({})) as { byPlugin?: Record<string, SaveResult>; reindexFailure?: ReindexFailure | null };
    const messages = [partialSaveMessage(body.byPlugin), staleIndexMessage(body.reindexFailure)].filter(Boolean);
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

  async function handleCopyTo(targetPlugin: string) {
    setActionError(null);
    try {
      const resp = await client.copyTo(formKey, targetPlugin);
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Copy failed: ${resp.statusText}`);
        return;
      }
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
      const resp = await client.removeOverride(formKey, plugin);
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Remove failed: ${resp.statusText}`);
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

  function handleCellDragStart(fieldName: string, value: unknown, sourcePlugin: string) {
    dragPayloadRef.current = { fieldName, value, sourcePlugin };
  }

  // Issue #3: target must be an editable plugin — reject a drop onto an immutable column as a
  // silent no-op (no PATCH attempt), distinct from typed edits into a read-only cell, which are
  // attempted and surfaced as a 409 by stageChange. Also guards against dropping onto an
  // unrelated field's row (payload fieldName must match the row it's dropped on).
  function handleCellDrop(fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) {
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
      // not silence (#198's policy).
      logAction('warn', `Rejected drop of '${fieldName}' onto immutable plugin ${targetPlugin}`);
      return;
    }
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
      const createResp = await client.createRecord(targetPlugin, source.recordType);
      if (!createResp.ok) {
        setActionError(createResp.status === 409 ? 'Plugin is read-only' : `Copy failed: ${createResp.statusText}`);
        return;
      }
      const { formKey: newFormKey } = await createResp.json() as { formKey: string };
      const fields: Record<string, unknown> = {};
      for (const fv of source.fields) fields[fv.metadata.name] = fv.value;
      const patchResp = await client.save(newFormKey, targetPlugin, fields);
      if (!patchResp.ok) {
        setActionError(`Copy failed: ${patchResp.statusText}`);
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
  function handleAddMaster(plugin: string, newMaster: string) {
    const override = overrideMap[plugin];
    if (!override) return;
    void handleEdit(plugin, 'masters', [...currentMasters(override), newMaster]);
  }

  // Issue #209: keeps columnHeaderActionsRef current every render, mirroring
  // pendingCellActionsRef below — the mount-only message listener's column-header branches
  // always need this render's formKey/overrideMap-derived handlers, not whatever closed over
  // pendingCellActionsRef when the listener was first attached.
  useLayoutEffect(() => {
    columnHeaderActionsRef.current = {
      formKey,
      copyAllToPending: (sourcePlugin, targetPlugin) => { void handleCopyAllToPending(sourcePlugin, targetPlugin); },
      copyAsNewRecord: (sourcePlugin, targetPlugin) => { void handleCopyAsNewRecord(sourcePlugin, targetPlugin); },
      copyAsOverride: targetPlugin => { void handleCopyTo(targetPlugin); },
      removeOverride: plugin => { void handleRemoveOverride(plugin); },
      addMaster: handleAddMaster,
    };
  });

  const columns = useMemo(
    () => result ? buildColumns(result.overrides, immutableSet) : [],
    [result, immutableSet],
  );

  const pendingChangeMap = useMemo((): Record<string, PendingChange> => {
    const map: Record<string, PendingChange> = {};
    for (const c of allChanges) map[`${c.plugin}:${c.fieldPath}`] = c;
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

  const { overrides, diffs, conflictAll } = result;

  const winner = overrides.find(o => o.isWinner);
  const displayId = (winner ?? overrides[0])?.editorId;
  const title = displayId ? `${displayId} [${formKey}]` : formKey;
  // Issue #86: the header record lives at the synthetic FormKey "000000:<plugin>" (CONTEXT.md);
  // only it has an editable masters field.
  const isHeaderRecord = formKey.startsWith('000000:');

  return (
    <div style={containerStyle}>
      <div style={{ flex: '0 0 auto', marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
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
                  const isCollapsed = collapsedColumns.has(col.override.plugin);
                  const isImmutable = immutableSet.has(col.override.plugin);
                  return (
                    <th
                      key={`disk:${col.override.plugin}`}
                      style={{ ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px', backgroundColor: getHeaderBg(col.override.conflictThis) }}
                      // Issue #209: the column-header menu (Copy All to Pending / Copy as New
                      // Record / Copy as Override… / Remove / Add Master) is VS Code's own
                      // `webview/context` menu now — no `onContextMenu`/`preventDefault()` here
                      // any more, same migration switch as #208's pending cells.
                      data-vscode-context={columnHeaderContext(
                        formKey, col.override.plugin, isImmutable, isHeaderRecord, currentMasters(col.override),
                      )}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={isImmutable}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.override.plugin)}
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
              const parentMeta = fieldMetaMap[diff.fieldName];
              const elementType = parentMeta?.type === 'array' ? parentMeta.elementType : undefined;
              // Issue #142: current (pending-over-disk) array for the "＋" add control, hoisted
              // above the per-child loop below so the parent row can use it too.
              const resolveCurrentArr = (plugin: string): unknown[] => {
                const diskArr = (diff.values[plugin] as unknown[]) ?? [];
                const pendingArr = overrideMap[plugin]?.pendingFields?.[diff.fieldName] as unknown[] | undefined;
                return pendingArr ?? diskArr;
              };
              const rows: React.ReactNode[] = [
                <DiffRow
                  key={diff.fieldName}
                  diff={diff}
                  conflictAll={conflictAll}
                  columns={columns}
                  overrideMap={overrideMap}
                  fieldMetaMap={fieldMetaMap}
                  immutableSet={immutableSet}
                  pendingChangeMap={pendingChangeMap}
                  collapsedColumns={collapsedColumns}
                  onCellDragStart={handleCellDragStart}
                  onCellDrop={handleCellDrop}
                  onOpen={handleOpen}
                  onEdit={(plugin, fieldName, value) => { void handleEdit(plugin, fieldName, value); }}
                  context={{ kind: 'top-level' }}
                  rowKey={diff.fieldName}
                  focusedCell={focusedCell}
                  onFocusCell={handleFocusCell}
                  hasChildren={hasChildren}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedStructs(prev => {
                    const next = new Set(prev);
                    if (next.has(diff.fieldName)) next.delete(diff.fieldName);
                    else next.add(diff.fieldName);
                    return next;
                  })}
                  // Issue #142: "＋" on the array's parent row — absent for sortable arrays and
                  // for non-array fields (elementType undefined covers both).
                  onArrayAdd={elementType != null && elementType.isSortable !== true
                    ? plugin => { void handleEdit(plugin, diff.fieldName, [...resolveCurrentArr(plugin), defaultElementValue(elementType)]); }
                    : undefined}
                />,
              ];
              if (hasChildren && isExpanded) {
                for (const child of diff.children ?? []) {
                  if (elementType != null) {
                    const elementMeta = elementType;
                    const childKey = `${diff.fieldName}.${child.fieldName}`;
                    const elemExpanded = expandedStructs.has(childKey);
                    const elemIdx = parseElementIndex(child.fieldName);
                    rows.push(
                      <DiffRow
                        key={childKey}
                        diff={child}
                        conflictAll={conflictAll}
                        columns={columns}
                        overrideMap={overrideMap}
                        fieldMetaMap={fieldMetaMap}
                        immutableSet={immutableSet}
                        pendingChangeMap={pendingChangeMap}
                        collapsedColumns={collapsedColumns}
                        onCellDragStart={handleCellDragStart}
                        onCellDrop={handleCellDrop}
                        onOpen={handleOpen}
                        onEdit={(plugin, elemKey, newValue) => {
                          void handleEdit(plugin, diff.fieldName, updateArrayAtKey(resolveCurrentArr(plugin), elemKey, newValue, elementMeta.isSortable ?? false));
                        }}
                        context={{ kind: 'array-element', overrideMeta: elementMeta, parentFieldName: diff.fieldName }}
                        rowKey={childKey}
                        focusedCell={focusedCell}
                        onFocusCell={handleFocusCell}
                        hasChildren={(child.children?.length ?? 0) > 0}
                        isExpanded={elemExpanded}
                        // Issue #142: move-up/move-down/remove — absent (not disabled) for
                        // sortable elements, whose order/arity isn't user-editable. Writes the
                        // whole array as one field edit (ADR-0017), same mechanism as element
                        // value edits above.
                        arrayEdit={elementMeta.isSortable !== true ? {
                          currentArray: resolveCurrentArr,
                          index: elemIdx,
                          onArrayEdit: (plugin, value) => { void handleEdit(plugin, diff.fieldName, value); },
                        } : undefined}
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
                            immutableSet={immutableSet}
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
                            context={{ kind: 'grandchild', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName, parentFieldIndex: elemIdx }}
                            rowKey={`${childKey}.${grandchild.fieldName}`}
                            focusedCell={focusedCell}
                            onFocusCell={handleFocusCell}
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
                        immutableSet={immutableSet}
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
                        context={{ kind: 'struct-child', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName }}
                        rowKey={`${diff.fieldName}.${child.fieldName}`}
                        focusedCell={focusedCell}
                        onFocusCell={handleFocusCell}
                      />,
                    );
                  }
                }
              }
              return rows;
            })}
            {!isHeaderRecord && result.hasVmad && (
              <VmadSection
                          vmad={result.vmad}
                          columns={columns}
                          onOpen={handleOpen}
                          immutableSet={immutableSet}
                          pendingChangeMap={pendingChangeMap}
                          onEdit={(plugin, vmadPath, value) => { void handleEdit(plugin, vmadPath, value); }}
                          onStructOp={(plugin, vmadPath, op) => { void handleVmadStructOp(plugin, vmadPath, op); }}
                        />
            )}
            {!isHeaderRecord && (
              <ConditionSection
                conditions={result.conditions}
                columns={columns}
                onOpen={handleOpen}
                immutableSet={immutableSet}
                onEdit={(plugin, path, value) => { void handleEdit(plugin, path, value); }}
                pendingChangeMap={pendingChangeMap}
              />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
