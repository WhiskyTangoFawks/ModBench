import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PluginHeader } from './PluginHeader';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { PendingCellMenu } from './PendingCellMenu';
import { RevertGroupConfirm } from './RevertGroupConfirm';
import { PluginTargetPicker } from './PluginTargetPicker';
import { DiffRow } from './DiffRow';
import { partialSaveMessage, staleIndexMessage } from '../../src/medit/saveClassification';
import type { ReindexFailure, SaveResult } from '../../src/medit/saveClassification';
import { buildColumns, defaultElementValue, parseElementIndex, updateArrayAtKey } from './recordUtils';
import { mono, fg, baseCell, headerCell, getConflictBg } from './gridStyles';
import { VmadSection } from './VmadSection';
import { ConditionSection } from './ConditionSection';
import type { CompareOverride, CompareResult, ConflictThis, FieldMetadata, PatchRecordValidationError, PendingChange } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, type ExtensionToWebview } from './messages';
import type { PluginInfo, RecordSessionClient } from './RecordSessionClient';

const mEditWindow = window as Window & typeof globalThis & {
  mEditFormKey: string;
};

const getHeaderBg = (c: ConflictThis | undefined): string | undefined => getConflictBg(c, 0.35);

// ── RecordPanel ───────────────────────────────────────────────────────────────

export function RecordPanel({ client }: Readonly<{ client: RecordSessionClient }>) {
  const [formKey, setFormKey] = useState<string>(mEditWindow.mEditFormKey ?? '');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [allChanges, setAllChanges] = useState<PendingChange[]>([]);
  const [allPlugins, setAllPlugins] = useState<PluginInfo[]>([]);
  const [immutableSet, setImmutableSet] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyPickerPlugin, setCopyPickerPlugin] = useState<string | null>(null);
  const [masterPickerPlugin, setMasterPickerPlugin] = useState<string | null>(null);
  const [expandedStructs, setExpandedStructs] = useState<Set<string>>(new Set());
  // Issue #3: collapsed plugin columns, keyed by plugin name. Deliberately NOT reset by the
  // LOAD_RECORD handler below (unlike copyPickerPlugin/masterPickerPlugin) — collapse state
  // is meant to persist across record-to-record navigation within the same panel session.
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  // Issue #3: transient drag payload — doesn't need to trigger a re-render, so a ref rather
  // than state. Cleared on drop (successful or rejected).
  const dragPayloadRef = useRef<{ fieldName: string; value: unknown } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ plugin: string; x: number; y: number } | null>(null);
  // Issue #3: target-plugin picker shared by "Copy All to Pending" and "Copy as New Record" —
  // same UI (position:fixed at the context menu's click coordinates, mutable-plugins-minus-source
  // target list), branching on `mode` only in onSelect.
  const [targetPickerSource, setTargetPickerSource] = useState<{ plugin: string; x: number; y: number; mode: 'copyAll' | 'newRecord' } | null>(null);
  // Issue #139: right-click menu on a pending value (Save Group / Revert Group), keyed on the
  // member change id it acts on; and the multi-member revert confirmation the ↩ / Revert Group
  // raise before dropping a whole component.
  const [pendingMenu, setPendingMenu] = useState<{ changeId: string; x: number; y: number } | null>(null);
  const [revertConfirm, setRevertConfirm] = useState<{ changeId: string; members: PendingChange[] } | null>(null);

  const refresh = useCallback(async (fk: string) => {
    if (!fk) return;
    try {
      setError(null);
      const loaded = await client.load(fk);
      if (!loaded.ok) throw new Error(loaded.error);
      setResult(loaded.result);
      if (loaded.changes) setAllChanges(loaded.changes);
      if (loaded.plugins) setAllPlugins(loaded.plugins);
      if (loaded.immutableSet) setImmutableSet(loaded.immutableSet);
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

  // Listen for loadRecord messages from extension (panel reuse)
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
        setAllChanges([]);
        setError(null);
        setActionError(null);
        setCopyPickerPlugin(null);
        setMasterPickerPlugin(null);
        void refreshRef.current(msg.formKey);
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
    await stageChange(plugin, { [fieldName]: value });
  }

  // VMAD structural ops (phase 13.8): stage an op payload under a single change type.
  async function handleVmadStructOp(plugin: string, vmadPath: string, op: unknown) {
    await stageChange(plugin, { [vmadPath]: op }, 'vmad_struct_op');
  }

  async function stageChange(plugin: string, fields: Record<string, unknown>, changeType?: string) {
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
      return;
    }
    await refresh(formKey);
  }

  // Issue #139: the ↩ and the context menu's Revert Group both revert the change's whole
  // component (ADR-0029). A group of one reverts straight away — the common case, exactly
  // "revert this field"; a multi-member group confirms first, listing what travels with it,
  // rather than firing the backend's 409 for a partial group revert (ADR-0028). The member
  // count comes from GET /changes for this change's component; a failed read yields [] and
  // takes the no-confirmation path, never a raw 409.
  async function handleRevertGroup(changeId: string) {
    setActionError(null);
    const members = await client.groupMembers(changeId);
    if (members.length > 1) {
      setRevertConfirm({ changeId, members });
      return;
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
    await refresh(formKey);
  }

  async function handleCopyTo(targetPlugin: string) {
    setActionError(null);
    try {
      const resp = await client.copyTo(formKey, targetPlugin);
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Copy failed: ${resp.statusText}`);
        return;
      }
      await refresh(formKey);
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  // Issue #3: "Remove Override" — stages a delete of this plugin's override of the current
  // record (Phase 10's DeleteRecords endpoint, reached here via the same raw-fetch pattern as
  // handleCopyTo — the webview never routes through SessionController/ApiClient).
  async function handleRemoveOverride(plugin: string) {
    setActionError(null);
    try {
      const resp = await client.removeOverride(formKey, plugin);
      if (!resp.ok) {
        setActionError(resp.status === 409 ? 'Plugin is read-only' : `Remove failed: ${resp.statusText}`);
        return;
      }
      await refresh(formKey);
    } catch (e) {
      setActionError(`Remove failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  function handleOpen(fk: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: fk });
  }

  // Issue #140: plain click on a pending value → reveal that change in the Pending Changes
  // tree. The extension host resolves the change id to a node and reveals it; the webview
  // cannot call TreeView.reveal itself.
  function handleRevealPendingChange(changeId: string) {
    vscode.postMessage({ type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE, changeId });
  }

  function handleCellDragStart(fieldName: string, value: unknown) {
    dragPayloadRef.current = { fieldName, value };
  }

  // Issue #3: target must be an editable plugin — reject a drop onto an immutable column as a
  // silent no-op (no PATCH attempt), distinct from typed edits into a read-only cell, which are
  // attempted and surfaced as a 409 by stageChange. Also guards against dropping onto an
  // unrelated field's row (payload fieldName must match the row it's dropped on).
  function handleCellDrop(fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) {
    const payload = dragPayloadRef.current;
    dragPayloadRef.current = null;
    if (!payload || payload.fieldName !== fieldName) return;
    if (immutableSet.has(targetPlugin)) return;
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
      }
    } catch (e) {
      setActionError(`Copy failed: ${e instanceof Error ? e.message : 'network error'}`);
    }
  }

  const columns = useMemo(
    () => result ? buildColumns(result.overrides, immutableSet) : [],
    [result, immutableSet],
  );

  const pendingChangeMap = useMemo((): Record<string, PendingChange> => {
    const map: Record<string, PendingChange> = {};
    for (const c of allChanges) map[`${c.plugin}:${c.fieldPath}`] = c;
    return map;
  }, [allChanges]);

  const containerStyle: React.CSSProperties = {
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
      <div style={{ marginBottom: 10, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
        {title}
      </div>
      {actionError && (
        <div style={{ marginBottom: 8, fontSize: '11px', color: 'var(--vscode-errorForeground, #f88)', padding: '3px 6px', border: '1px solid var(--vscode-inputValidation-errorBorder, #f88)', borderRadius: 2 }}>
          {actionError}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...headerCell, textAlign: 'left', minWidth: '160px' }}>Field</th>
              {columns.map(col => {
                if (col.kind === 'disk') {
                  const isCollapsed = collapsedColumns.has(col.override.plugin);
                  return (
                    <th
                      key={`disk:${col.override.plugin}`}
                      style={{ ...headerCell, textAlign: 'left', minWidth: isCollapsed ? '48px' : '200px', backgroundColor: getHeaderBg(col.override.conflictThis) }}
                      onContextMenu={e => {
                        e.preventDefault();
                        setContextMenu({ plugin: col.override.plugin, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <PluginHeader
                        override={col.override}
                        isImmutable={immutableSet.has(col.override.plugin)}
                        isHeaderRecord={isHeaderRecord}
                        showCopyPicker={copyPickerPlugin === col.override.plugin}
                        mutableTargets={allPlugins.filter(p => !p.isImmutable)}
                        showMasterPicker={masterPickerPlugin === col.override.plugin}
                        loadedPlugins={allPlugins}
                        collapsed={isCollapsed}
                        onToggleCollapse={() => toggleColumnCollapse(col.override.plugin)}
                        onOpenCopyPicker={() => setCopyPickerPlugin(col.override.plugin)}
                        onCloseCopyPicker={() => setCopyPickerPlugin(null)}
                        onCopyTo={p => { void handleCopyTo(p); }}
                        onOpenMasterPicker={() => setMasterPickerPlugin(col.override.plugin)}
                        onCloseMasterPicker={() => setMasterPickerPlugin(null)}
                        onAddMaster={newMasters => { void handleEdit(col.override.plugin, 'masters', newMasters); }}
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
                  client={client}
                  pendingChangeMap={pendingChangeMap}
                  collapsedColumns={collapsedColumns}
                  onCellDragStart={handleCellDragStart}
                  onCellDrop={handleCellDrop}
                  onOpen={handleOpen}
                  onEdit={(plugin, fieldName, value) => { void handleEdit(plugin, fieldName, value); }}
                  onRevert={changeId => { void handleRevertGroup(changeId); }}
                  onPendingContextMenu={(changeId, x, y) => setPendingMenu({ changeId, x, y })}
                  onRevealPendingChange={handleRevealPendingChange}
                  context={{ kind: 'top-level' }}
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
                        client={client}
                        pendingChangeMap={pendingChangeMap}
                        collapsedColumns={collapsedColumns}
                        onCellDragStart={handleCellDragStart}
                        onCellDrop={handleCellDrop}
                        onOpen={handleOpen}
                        onEdit={(plugin, elemKey, newValue) => {
                          void handleEdit(plugin, diff.fieldName, updateArrayAtKey(resolveCurrentArr(plugin), elemKey, newValue, elementMeta.isSortable ?? false));
                        }}
                        onRevert={changeId => { void handleRevertGroup(changeId); }}
                        onPendingContextMenu={(changeId, x, y) => setPendingMenu({ changeId, x, y })}
                        onRevealPendingChange={handleRevealPendingChange}
                        context={{ kind: 'array-element', overrideMeta: elementMeta, parentFieldName: diff.fieldName }}
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
                            client={client}
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
                            onRevert={changeId => { void handleRevertGroup(changeId); }}
                            onPendingContextMenu={(changeId, x, y) => setPendingMenu({ changeId, x, y })}
                            onRevealPendingChange={handleRevealPendingChange}
                            context={{ kind: 'grandchild', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName, parentFieldIndex: elemIdx }}
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
                        client={client}
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
                        onRevert={changeId => { void handleRevertGroup(changeId); }}
                        onPendingContextMenu={(changeId, x, y) => setPendingMenu({ changeId, x, y })}
                        onRevealPendingChange={handleRevealPendingChange}
                        context={{ kind: 'struct-child', overrideMeta: subFieldMeta, parentFieldName: diff.fieldName }}
                      />,
                    );
                  }
                }
              }
              return rows;
            })}
            {!isHeaderRecord && (
              <VmadSection
                          vmad={result.vmad}
                          columns={columns}
                          onOpen={handleOpen}
                          immutableSet={immutableSet}
                          pendingChangeMap={pendingChangeMap}
                          onEdit={(plugin, vmadPath, value) => { void handleEdit(plugin, vmadPath, value); }}
                          onRevert={changeId => { void handleRevertGroup(changeId); }}
                          onPendingContextMenu={(changeId, x, y) => setPendingMenu({ changeId, x, y })}
                          onRevealPendingChange={handleRevealPendingChange}
                          onStructOp={(plugin, vmadPath, op) => { void handleVmadStructOp(plugin, vmadPath, op); }}
                          client={client}
                        />
            )}
            {!isHeaderRecord && (
              <ConditionSection
                conditions={result.conditions}
                columns={columns}
                onOpen={handleOpen}
              />
            )}
          </tbody>
        </table>
      </div>
      {contextMenu && (
        <ColumnHeaderMenu
          x={contextMenu.x}
          y={contextMenu.y}
          disabledRemove={immutableSet.has(contextMenu.plugin)}
          onClose={() => setContextMenu(null)}
          onCopyAllToPending={() => { setTargetPickerSource({ ...contextMenu, mode: 'copyAll' }); setContextMenu(null); }}
          onCopyAsNewRecord={() => { setTargetPickerSource({ ...contextMenu, mode: 'newRecord' }); setContextMenu(null); }}
          onRemoveOverride={() => { const plugin = contextMenu.plugin; setContextMenu(null); void handleRemoveOverride(plugin); }}
        />
      )}
      {targetPickerSource && (
        <PluginTargetPicker
          x={targetPickerSource.x}
          y={targetPickerSource.y}
          targets={allPlugins.filter(p => !p.isImmutable && p.name !== targetPickerSource.plugin)}
          onClose={() => setTargetPickerSource(null)}
          onSelect={target => {
            const { plugin: source, mode } = targetPickerSource;
            setTargetPickerSource(null);
            if (mode === 'copyAll') void handleCopyAllToPending(source, target);
            else void handleCopyAsNewRecord(source, target);
          }}
        />
      )}
      {pendingMenu && (
        <PendingCellMenu
          x={pendingMenu.x}
          y={pendingMenu.y}
          onClose={() => setPendingMenu(null)}
          onSaveGroup={() => { const id = pendingMenu.changeId; setPendingMenu(null); void handleSaveGroup(id); }}
          onRevertGroup={() => { const id = pendingMenu.changeId; setPendingMenu(null); void handleRevertGroup(id); }}
        />
      )}
      {revertConfirm && (
        <RevertGroupConfirm
          members={revertConfirm.members}
          onCancel={() => setRevertConfirm(null)}
          onConfirm={() => { const id = revertConfirm.changeId; setRevertConfirm(null); void revertGroup(id); }}
        />
      )}
    </div>
  );
}
