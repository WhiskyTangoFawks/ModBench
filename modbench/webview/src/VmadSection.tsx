import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type { ConflictThis, PendingChange, VmadCompare, VmadKind, VmadPropertyDiff } from './types';
import { toStr } from './recordUtils';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle, fg } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';
import type { RecordSessionClient } from './RecordSessionClient';
import { VmadScalarEditor } from './VmadScalarEditor';
import { VmadObjectEditor } from './VmadObjectEditor';
import { AddPropertyButton, RemovePropertyButton, SetTypeControl, PropertyFlagsControl } from './VmadPropertyOps';
import { AddScriptButton, RemoveScriptButton, ScriptFlagsControl } from './VmadScriptOps';
import {
  type StructOp, type OnStructOp,
  isStructOp, opScalarKind, parseVmadPath, parseVmadScriptPath,
} from './vmadOps';

export type { StructOp };

interface VmadSectionProps {
  vmad: VmadCompare | null | undefined;
  columns: Column[];
  onOpen: (fk: string) => void;
  // Issue #111: plugins whose columns are read-only. Replaces the old `editMode` flag — VMAD
  // controls follow the column's mutability, not a mode. Required, not optional: the flag it
  // replaced was fail-closed (absent meant "not editing"), and an immutability guard must not
  // fail open. An empty set is a caller saying "every column is editable", which is a claim
  // worth having to make out loud.
  immutableSet: Set<string>;
  pendingChangeMap?: Record<string, PendingChange>;
  onEdit?: (plugin: string, vmadPath: string, value: unknown) => void;
  onRevert?: (changeId: string) => void;
  // Issue #139: right-click a pending value → Save Group / Revert Group. Threaded down to every
  // pending-cell renderer so VMAD pending values offer the same actions as ordinary fields.
  onPendingContextMenu?: (changeId: string, x: number, y: number) => void;
  // Issue #140: plain click on a pending value reveals its change in the Pending Changes tree —
  // the same gesture and the same guard as the field grid's pending column (Ctrl/meta-click is
  // left alone so an object leaf's FormKeyLink can still follow the reference).
  onRevealPendingChange?: (changeId: string) => void;
  onStructOp?: OnStructOp;
  client?: RecordSessionClient;
}

export interface ArrayEditCtx {
  vmadPath: string;
  index: number;
  siblingsByPlugin: Record<string, unknown[]>;
}

// A Struct/ArrayOfStruct edits as one atomic column: any nested member edit restages the whole
// subtree (the `raw` node tree) at the property path. nodePath locates this row's node within raw.
export interface StructEditCtx {
  structPath: string;                          // VMAD\Script\Prop
  raw: Record<string, unknown> | null | undefined;
  nodePath: (string | number)[];               // struct root = node[]; structList root = node[][] (leading index)
}

// Walks `raw[plugin]` to the node addressed by nodePath. Member-name segments index a node list;
// a leading numeric segment selects a structList instance's member list.
function nodeAt(root: unknown, path: (string | number)[]): Record<string, unknown> | undefined {
  const startsWithIndex = typeof path[0] === 'number';
  let list = (startsWithIndex ? (root as unknown[])[path[0] as number] : root) as Record<string, unknown>[];
  let node: Record<string, unknown> | undefined;
  for (let k = startsWithIndex ? 1 : 0; k < path.length; k++) {
    node = list.find(n => n.name === path[k]);
    if (node && k < path.length - 1) list = node.members as Record<string, unknown>[];
  }
  return node;
}

function setNodeValue(node: Record<string, unknown>, p: VmadPropertyDiff, v: unknown): void {
  if (p.kind === 'object') {
    const o = v as { formKey: string; alias: number };
    node.formKeyValue = o.formKey;
    node.aliasValue = o.alias;
    return;
  }
  switch (scalarType(p)) {
    case 'bool': node.boolValue = v; break;
    case 'int': node.intValue = v; break;
    case 'float': node.floatValue = v; break;
    default: node.stringValue = v;
  }
}

// A new ArrayOfStruct element clones the first element's member shape with default values.
function defaultNode(n: Record<string, unknown>): Record<string, unknown> {
  const c = { ...n };
  if ('boolValue' in c) c.boolValue = false;
  if ('intValue' in c) c.intValue = 0;
  if ('floatValue' in c) c.floatValue = 0;
  if ('stringValue' in c) c.stringValue = '';
  if ('formKeyValue' in c) { c.formKeyValue = ''; c.aliasValue = -1; }
  if (Array.isArray(c.members)) c.members = (c.members as Record<string, unknown>[]).map(defaultNode);
  return c;
}

// Removes the node addressed by nodePath from a (cloned) raw root: a member from its node list,
// or an ArrayOfStruct instance (leading-number path) from the instance list.
function removeAt(root: unknown, path: (string | number)[]): unknown {
  const last = path.at(-1);
  if (path.length === 1) {
    return typeof last === 'number'
      ? (root as unknown[]).filter((_, j) => j !== last)
      : (root as Record<string, unknown>[]).filter(n => n.name !== last);
  }
  const parentPath = path.slice(0, -1);
  const list = (parentPath.length === 1 && typeof parentPath[0] === 'number')
    ? (root as Record<string, unknown>[][])[parentPath[0]]
    : nodeAt(root, parentPath)!.members as Record<string, unknown>[];
  const idx = list.findIndex(n => n.name === last);
  if (idx >= 0) list.splice(idx, 1);
  return root;
}

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
};

const inlineCell: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };

function StructAddButton({ plugin, structPath, raw, onEdit }: Readonly<{
  plugin: string; structPath: string; raw: Record<string, unknown> | null | undefined; onEdit: OnEdit;
}>) {
  return (
    <button
      title="Add struct"
      onClick={() => {
        const root = structuredClone(raw?.[plugin] ?? []) as Record<string, unknown>[][];
        const template = root[0];
        root.push(template ? template.map(defaultNode) : []);
        onEdit(plugin, structPath, root);
      }}
      style={{ ...iconBtnStyle, color: fg, fontSize: '14px', padding: '0 4px' }}
    >+</button>
  );
}

function StructRemoveButton({ plugin, structCtx, onEdit }: Readonly<{
  plugin: string; structCtx: StructEditCtx; onEdit: OnEdit;
}>) {
  const last = structCtx.nodePath.at(-1);
  return (
    <button
      title={typeof last === 'number' ? 'Remove struct' : 'Remove member'}
      onClick={() => onEdit(plugin, structCtx.structPath,
        removeAt(structuredClone(structCtx.raw?.[plugin] ?? []), structCtx.nodePath))}
      style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
    >×</button>
  );
}

// All per-plugin row context, bundled so the cell renderers stay module-level (and simple).
interface RowRenderCtx {
  p: VmadPropertyDiff;
  isExpanded: boolean;
  arrayCtx?: ArrayEditCtx;
  structCtx?: StructEditCtx;
  siblingsByPlugin?: Record<string, unknown[]>;
  arrayVmadPath?: string;
  elementType: string;
  structRootPath?: string;
  leafPath?: string;
  typesDiffer: boolean;
  // Issue #111: onEdit for this plugin's column, or undefined when that column is read-only.
  editFor: (plugin: string) => OnEdit | undefined;
  leafCtx: LeafCellCtx;
  onOpen: (fk: string) => void;
}

function containerCell(plugin: string, c: RowRenderCtx, remove: React.ReactNode): React.ReactNode {
  const { p, isExpanded, siblingsByPlugin, arrayVmadPath, elementType, structRootPath } = c;
  const edit = c.editFor(plugin);
  if (isExpanded) {
    if (edit && siblingsByPlugin && arrayVmadPath)
      return <ArrayAddButton plugin={plugin} arrayVmadPath={arrayVmadPath} currentArr={siblingsByPlugin[plugin] ?? []} elementType={elementType} onEdit={edit} />;
    if (edit && structRootPath && p.kind === 'structList')
      return <StructAddButton plugin={plugin} structPath={structRootPath} raw={p.raw} onEdit={edit} />;
    return remove;
  }
  const summary = hasPluginData(p, plugin) ? containerSummary(p) : null;
  return remove ? <span style={inlineCell}>{summary}{remove}</span> : summary;
}

function memberCell(plugin: string, c: RowRenderCtx, remove: React.ReactNode): React.ReactNode {
  const { p, arrayCtx, structCtx, leafPath, typesDiffer, leafCtx, onOpen } = c;
  const edit = c.editFor(plugin);
  const path = arrayCtx ? arrayCtx.vmadPath : leafPath;
  const typeCue = typesDiffer ? `(${p.types[plugin]})` : null;
  const editor = (path || structCtx)
    ? renderLeafCell(p, plugin, path ?? '', arrayCtx, structCtx, leafCtx, typesDiffer)
    : leafContent(p, plugin, onOpen, typeCue);
  if (arrayCtx && edit)
    return <ArrayElementCell plugin={plugin} arrayCtx={arrayCtx} onEdit={edit} editor={editor} />;
  return remove ? <span style={inlineCell}>{editor}{remove}</span> : editor;
}

function propertyCell(plugin: string, c: RowRenderCtx): React.ReactNode {
  const edit = c.editFor(plugin);
  const remove = edit && c.structCtx
    ? <StructRemoveButton plugin={plugin} structCtx={c.structCtx} onEdit={edit} />
    : null;
  return isContainerKind(c.p.kind) ? containerCell(plugin, c, remove) : memberCell(plugin, c, remove);
}

// Per-row VMAD path classification. Only depth-1 properties carry a top-level path; struct/array
// internals address their atomic column via the struct/array root instead.
function rowPaths(depth: number, p: VmadPropertyDiff, scriptName: string) {
  const top = `VMAD\\${scriptName}\\${p.name}`;
  const isContainer = isContainerKind(p.kind);
  const structRootPath = depth === 1 && (p.kind === 'struct' || p.kind === 'structList') ? top : undefined;
  return {
    isContainer,
    leafPath: depth === 1 && !isContainer ? top : undefined,
    arrayVmadPath: depth === 1 && p.kind === 'array' ? top : undefined,
    structRootPath,
  };
}

// Struct edit context for a child row: extends the parent path by one segment (member name, or
// instance index for an ArrayOfStruct). Undefined outside a struct subtree.
function makeChildStructCtx(
  p: VmadPropertyDiff, c: VmadPropertyDiff, i: number,
  structRootPath: string | undefined, structCtx: StructEditCtx | undefined,
): StructEditCtx | undefined {
  const seg: string | number = p.kind === 'structList' ? i : c.name;
  if (structRootPath) return { structPath: structRootPath, raw: p.raw, nodePath: [seg] };
  if (structCtx) return { ...structCtx, nodePath: [...structCtx.nodePath, seg] };
  return undefined;
}

function isContainerKind(kind: VmadKind): kind is 'array' | 'struct' | 'structList' {
  return kind === 'array' || kind === 'struct' || kind === 'structList';
}

function buildSiblingsByPlugin(children: VmadPropertyDiff[]): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [i, c] of children.entries()) {
    for (const [plugin, val] of Object.entries(c.values)) {
      if (!result[plugin]) result[plugin] = [];
      result[plugin][i] = val;
    }
  }
  return result;
}

function defaultElementValue(elementType: string): unknown {
  if (elementType === 'Bool') return false;
  if (elementType === 'Float') return 0;
  if (elementType === 'String') return '';
  if (elementType === 'Object') return { formKey: '', alias: -1 };
  return 0; // Int and unknown
}

interface AddButtonProps {
  plugin: string;
  arrayVmadPath: string;
  currentArr: unknown[];
  elementType: string;
  onEdit: OnEdit;
}

function ArrayAddButton({ plugin, arrayVmadPath, currentArr, elementType, onEdit }: Readonly<AddButtonProps>) {
  return (
    <button
      title="Add element"
      onClick={() => onEdit(plugin, arrayVmadPath, [...currentArr, defaultElementValue(elementType)])}
      style={{ ...iconBtnStyle, color: fg, fontSize: '14px', padding: '0 4px' }}
    >+</button>
  );
}

interface ArrayElementCellProps {
  plugin: string;
  arrayCtx: ArrayEditCtx;
  onEdit: OnEdit;
  editor: React.ReactNode;
}

function ArrayElementCell({ plugin, arrayCtx, onEdit, editor }: Readonly<ArrayElementCellProps>) {
  const siblings = arrayCtx.siblingsByPlugin[plugin] ?? [];
  const { index, vmadPath } = arrayCtx;
  const swap = (j: number) => {
    const next = [...siblings];
    [next[index], next[j]] = [next[j], next[index]];
    onEdit(plugin, vmadPath, next);
  };
  return (
    <span style={inlineCell}>
      {editor}
      <button
        title="Move up"
        disabled={index === 0}
        onClick={() => swap(index - 1)}
        style={iconBtnStyle}
      >▲</button>
      <button
        title="Move down"
        disabled={index === siblings.length - 1}
        onClick={() => swap(index + 1)}
        style={iconBtnStyle}
      >▼</button>
      <button
        title="Remove element"
        onClick={() => onEdit(plugin, vmadPath, siblings.filter((_, j) => j !== index))}
        style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
      >×</button>
    </span>
  );
}

type OnEdit = (plugin: string, vmadPath: string, value: unknown) => void;

interface LeafCellCtx {
  // Issue #111: per-column editability — a leaf cell in an immutable column never edits.
  isEditable: (plugin: string) => boolean;
  onEdit?: OnEdit;
  client?: RecordSessionClient;
  onOpen: (fk: string) => void;
}

// Issue #111: a leaf cell reads as text and swaps to its editor only when clicked — the same
// rule as the field grid above it, and for the same reason: a wall of inputs would bury the
// values. Closes again when focus leaves the editor.
//
// Ctrl+click is not an edit anywhere in the grid: on an object leaf the FormKeyLink inside the
// read view follows the reference on that same event, so activating here as well would open an
// editor behind the record we just navigated to.
function ClickToEdit({ read, children }: Readonly<{ read: React.ReactNode; children: React.ReactNode }>) {
  const [active, setActive] = useState(false);
  if (!active) {
    return (
      <span
        onClick={e => { if (!e.ctrlKey && !e.metaKey) setActive(true); }}
        style={{ cursor: 'text' }}
      >{read}</span>
    );
  }
  return (
    <span onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setActive(false); }}>
      {children}
    </span>
  );
}

function renderLeafCell(
  p: VmadPropertyDiff,
  plugin: string,
  vmadPath: string,
  arrayCtx: ArrayEditCtx | undefined,
  structCtx: StructEditCtx | undefined,
  ctx: LeafCellCtx,
  typesDiffer: boolean,
): React.ReactNode {
  const { isEditable, onEdit, client, onOpen } = ctx;
  const typeCue = typesDiffer ? `(${p.types[plugin]})` : null;
  const read = leafContent(p, plugin, onOpen, typeCue);
  if (!isEditable(plugin) || !onEdit) return read;

  function commit(v: unknown) {
    if (structCtx) {
      const root = structuredClone(structCtx.raw?.[plugin] ?? []);
      const node = nodeAt(root, structCtx.nodePath);
      if (node) { setNodeValue(node, p, v); onEdit(plugin, structCtx.structPath, root); }
    } else if (arrayCtx) {
      const siblings = arrayCtx.siblingsByPlugin[plugin] ?? [];
      const next = [...siblings];
      next[arrayCtx.index] = v;
      onEdit(plugin, arrayCtx.vmadPath, next);
    } else {
      onEdit(plugin, vmadPath, v);
    }
  }

  if (p.kind === 'scalar') {
    return (
      <ClickToEdit read={read}>
        <VmadScalarEditor value={p.values[plugin]} type={scalarType(p)} onCommit={commit} />
      </ClickToEdit>
    );
  }
  if (p.kind === 'object' && client != null) {
    return (
      <ClickToEdit read={read}>
        <VmadObjectEditor value={p.values[plugin]} client={client} onCommit={commit} />
      </ClickToEdit>
    );
  }
  return read;
}

function hasPluginData(p: VmadPropertyDiff, plugin: string): boolean {
  if (p.children && p.children.length > 0) return p.children.some(c => hasPluginData(c, plugin));
  return p.values[plugin] != null || plugin in p.cellStates;
}

function containerSummary(p: VmadPropertyDiff): string {
  const n = p.children?.length ?? 0;
  if (p.kind === 'struct') return '{…}';
  if (p.kind === 'structList') return `[${n} structs]`;
  return `[${n} items]`;
}

// Spec rule 2's resolve gate, as far as VMAD data can carry it. A Papyrus Object property
// arrives as the formatted string "{FormKey} [{Alias}]", and an unset one formats as
// "Null [-1]" — so a well-formed FormKey is the strongest resolve test available here.
//
// This is weaker than the field grid's, which at least has the backend's checkError. A VMAD
// property carries no checkError and no resolution (VmadPropertyDiff is FormKey strings and
// conflict states), so an Object pointing at a FormKey that is absent from the index still
// looks followable. Catching that needs the resolution #141 adds to the compare response —
// the same gap, one ticket wider than the field grid's.
function isFormKey(s: string): boolean {
  return /^[0-9A-Fa-f]{6,8}:.+/.test(s);
}

function leafContent(
  p: VmadPropertyDiff,
  plugin: string,
  onOpen: (fk: string) => void,
  typeCue: string | null,
): React.ReactNode {
  if (p.kind === 'variable') {
    const present = plugin in p.cellStates || p.values[plugin] != null;
    if (!present) return null;
    return p.types[plugin]?.startsWith('ArrayOf') ? '(variables)' : '(Variable)';
  }

  const v = p.values[plugin];
  if (v == null) return <span style={{ opacity: 0.35 }}>—</span>;

  if (p.kind === 'object') {
    const str = toStr(v);
    const m = /^(.+?)\s*(\[-?\d+\])\s*$/.exec(str);
    const fk = m ? m[1] : str;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <FormKeyLink value={fk} onOpen={onOpen} linksTo={isFormKey(fk)} />
        {m && <span>&nbsp;{m[2]}</span>}
        {typeCue && <span style={{ opacity: 0.6 }}>&nbsp;{typeCue}</span>}
      </span>
    );
  }

  return (
    <span>
      {toStr(v)}
      {typeCue && <span style={{ opacity: 0.6 }}>&nbsp;{typeCue}</span>}
    </span>
  );
}

// ── Edit widgets ──────────────────────────────────────────────────────────────

function scalarType(p: VmadPropertyDiff): 'bool' | 'int' | 'float' | 'string' {
  return opScalarKind(p.types[p.winnerPlugin] ?? '') ?? 'string';
}

// Pending-column label for a VMAD change (op-aware): structural ops render distinctly.
function pendingOpLabel(v: unknown): React.ReactNode {
  if (isStructOp(v)) {
    if (v.op === 'remove_property') return <span style={{ textDecoration: 'line-through' }}>removed</span>;
    if (v.op === 'set_type') return <span>→ {(v as { type?: string }).type ?? ''}</span>;
    if (v.op === 'add_property') return <span>{toStr((v as { value?: unknown }).value)}</span>;
    return <span>{v.op}</span>;
  }
  return <span>{toStr(v)}</span>;
}

// Renders a pending add_property in the pending column: an inline editor (scalar) in edit mode that
// re-issues the same add op with the new value, else a read-only value. Plus a revert control.
function AddedPendingCell({ change, editable, onStructOp, onRevert, onPendingContextMenu, onRevealPendingChange }: Readonly<{
  change: PendingChange; editable?: boolean; onStructOp?: OnStructOp; onRevert?: (id: string) => void;
  onPendingContextMenu?: (changeId: string, x: number, y: number) => void;
  onRevealPendingChange?: (changeId: string) => void;
}>) {
  const op = change.newValue as StructOp & { type: string; name: string; value: unknown };
  const kind = opScalarKind(op.type);
  const reissue = (v: unknown) => onStructOp?.(change.plugin, change.fieldPath, { ...op, value: v });
  // Issue #140: this cell can itself be editable (a not-yet-saved add_property can be re-issued
  // with a new value) — unlike every other pending cell, which is always read-only. Reveal-on-
  // click only applies to the read-only rendering; a click meant to open the value editor must
  // not also fire a reveal.
  const editing = editable && onStructOp && kind;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}
      onContextMenu={onPendingContextMenu ? e => { e.preventDefault(); onPendingContextMenu(change.id, e.clientX, e.clientY); } : undefined}
      onClick={!editing && onRevealPendingChange ? e => { if (!e.ctrlKey && !e.metaKey) onRevealPendingChange(change.id); } : undefined}>
      {editing
        ? <VmadScalarEditor value={op.value} type={kind} onCommit={reissue} ariaLabel={`Added value for ${op.name}`} />
        : <span>{toStr(op.value)}</span>}
      {onRevert && (
        <button onClick={e => { e.stopPropagation(); onRevert(change.id); }} title="Revert group"
          style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)', fontSize: '11px' }}>↩</button>
      )}
    </span>
  );
}

// ── VmadSection ────────────────────────────────────────────────────────────────

export function VmadSection({
  vmad, columns, onOpen,
  immutableSet, pendingChangeMap, onEdit, onRevert, onPendingContextMenu, onRevealPendingChange, onStructOp, client,
}: Readonly<VmadSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scripts = vmad?.scripts ?? [];
  // Issue #111: editability is per column. The add-script row exists when any disk column is
  // editable; each column's button is gated individually below.
  const isEditable = (plugin: string) => !immutableSet.has(plugin);
  const showAddScript = onStructOp != null
    && columns.some(c => c.kind === 'disk' && isEditable(c.override.plugin));

  // Pending add_script ops (script-level paths) not yet in the compare tree → synthetic script rows.
  const existingScriptNames = new Set(scripts.map(s => s.name));
  const pendingScriptAdds = new Map<string, Record<string, PendingChange>>();
  if (pendingChangeMap) {
    for (const c of Object.values(pendingChangeMap)) {
      if (!isStructOp(c.newValue) || c.newValue.op !== 'add_script') continue;
      const name = parseVmadScriptPath(c.fieldPath);
      if (name == null || existingScriptNames.has(name)) continue;
      const m = pendingScriptAdds.get(name) ?? {};
      m[c.plugin] = c;
      pendingScriptAdds.set(name, m);
    }
  }

  if (scripts.length === 0 && !showAddScript && pendingScriptAdds.size === 0) return null;

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalCols = columns.length + 1;

  const valueCells = (
    rowKey: string,
    cellStates: Record<string, ConflictThis | undefined>,
    render: (plugin: string) => React.ReactNode,
    vmadPath?: string,
  ): React.ReactNode[] =>
    columns.map((col, i) => {
      if (col.kind === 'pending') {
        const change = vmadPath && pendingChangeMap ? pendingChangeMap[`${col.plugin}:${vmadPath}`] : undefined;
        const hasPending = change != null;
        return (
          <td
            key={`${rowKey}:p${i}`}
            style={{
              ...baseCell,
              backgroundColor: hasPending ? 'rgba(255,200,50,0.10)' : undefined,
              fontStyle: 'italic',
              opacity: hasPending ? 1 : 0.3,
            }}
            onContextMenu={hasPending && onPendingContextMenu
              ? e => { e.preventDefault(); onPendingContextMenu(change.id, e.clientX, e.clientY); }
              : undefined}
            onClick={hasPending && onRevealPendingChange
              ? e => { if (!e.ctrlKey && !e.metaKey) onRevealPendingChange(change.id); }
              : undefined}
          >
            {hasPending && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {pendingOpLabel(change.newValue)}
                {onRevert && (
                  <button
                    onClick={e => { e.stopPropagation(); onRevert(change.id); }}
                    title="Revert group"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--vscode-errorForeground, #f88)',
                      fontSize: '11px',
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >↩</button>
                )}
              </span>
            )}
          </td>
        );
      }
      const plugin = col.override.plugin;
      const style = { ...baseCell, ...getCellStyle(cellStates[plugin]) };
      return <td key={`${rowKey}:d${i}`} style={style}>{render(plugin)}</td>;
    });

  const rows: React.ReactNode[] = [];

  rows.push(
    <tr key="vmad-header">
      <td colSpan={totalCols} style={headerCell}>Scripts (VMAD)</td>
    </tr>,
  );

  if (showAddScript) {
    rows.push(
      <tr key="vmad-add-script">
        <td style={{ ...baseCell, opacity: 0.85 }}>＋ script</td>
        {columns.map((col, i) => col.kind === 'pending' || !isEditable(col.override.plugin)
          ? <td key={`add-script:${i}`} style={baseCell} />
          : <td key={`add-script:d${i}`} style={baseCell}><AddScriptButton plugin={col.override.plugin} onStructOp={onStructOp} /></td>)}
      </tr>,
    );
  }

  const leafCtx: LeafCellCtx = { isEditable, onEdit, client, onOpen };

  const pushPropertyRows = (
    p: VmadPropertyDiff,
    parentKey: string,
    depth: number,
    scriptName: string,
    arrayCtx?: ArrayEditCtx,
    structCtx?: StructEditCtx,
  ) => {
    const key = `${parentKey}>${p.name}`;
    const { isContainer, leafPath, arrayVmadPath, structRootPath } = rowPaths(depth, p, scriptName);
    const hasChildren = isContainer && (p.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(key);
    const typesDiffer = Object.values(p.types).some((t, _, a) => t !== a[0]);

    // Pre-build siblings so the Add button (on the parent array row) can append a default value.
    const siblingsByPlugin = (arrayVmadPath && isExpanded)
      ? buildSiblingsByPlugin(p.children ?? [])
      : undefined;
    const elementType = arrayVmadPath && p.children?.[0]
      ? p.children[0].types[p.children[0].winnerPlugin] ?? 'Int'
      : 'Int';

    const rowCtx: RowRenderCtx = {
      p, isExpanded, arrayCtx, structCtx, siblingsByPlugin, arrayVmadPath, elementType,
      structRootPath, leafPath, typesDiffer,
      editFor: plugin => (onEdit && isEditable(plugin) ? onEdit : undefined), leafCtx, onOpen,
    };

    rows.push(
      <tr key={key}>
        <td style={{ ...baseCell, paddingLeft: 8 + depth * 16, opacity: 0.85 }}>
          {hasChildren && (
            <button style={toggleBtnStyle} onClick={() => toggle(key)}>{isExpanded ? '▼' : '▶'}</button>
          )}
          {p.name}
        </td>
        {valueCells(key, p.cellStates, plugin =>
          depth === 1 && isEditable(plugin) && onStructOp
            ? <span style={inlineCell}>
                {propertyCell(plugin, rowCtx)}
                <SetTypeControl plugin={plugin} scriptName={scriptName} propName={p.name}
                  currentType={p.types[plugin] ?? p.types[p.winnerPlugin] ?? ''} onStructOp={onStructOp} />
                <PropertyFlagsControl plugin={plugin} scriptName={scriptName} propName={p.name} onStructOp={onStructOp} />
                <RemovePropertyButton plugin={plugin} scriptName={scriptName} propName={p.name} onStructOp={onStructOp} />
              </span>
            : propertyCell(plugin, rowCtx),
          arrayVmadPath ?? leafPath ?? structRootPath)}
      </tr>,
    );

    if (!hasChildren || !isExpanded) return;
    for (const [i, c] of (p.children ?? []).entries()) {
      const childArrayCtx = (p.kind === 'array' && arrayVmadPath && siblingsByPlugin)
        ? { vmadPath: arrayVmadPath, index: i, siblingsByPlugin }
        : undefined;
      pushPropertyRows(c, key, depth + 1, scriptName, childArrayCtx,
        makeChildStructCtx(p, c, i, structRootPath, structCtx));
    }
  };

  // Pending add_property ops for a script, grouped by property name → per-plugin change.
  // These are not yet in the compare tree (they apply on save), so they render as synthetic rows.
  const pendingAddsForScript = (scriptName: string, existing: Set<string>): Map<string, Record<string, PendingChange>> => {
    const byName = new Map<string, Record<string, PendingChange>>();
    if (!pendingChangeMap) return byName;
    for (const c of Object.values(pendingChangeMap)) {
      if (!isStructOp(c.newValue) || c.newValue.op !== 'add_property') continue;
      const parsed = parseVmadPath(c.fieldPath);
      if (!parsed || parsed.script !== scriptName || existing.has(parsed.prop)) continue;
      const m = byName.get(parsed.prop) ?? {};
      m[c.plugin] = c;
      byName.set(parsed.prop, m);
    }
    return byName;
  };

  const pushAddedRow = (parentKey: string, propName: string, perPlugin: Record<string, PendingChange>) => {
    const rowKey = `${parentKey}>added>${propName}`;
    rows.push(
      <tr key={rowKey}>
        <td style={{ ...baseCell, paddingLeft: 8 + 16, opacity: 0.85 }}>
          <span style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground, #8f8)', marginRight: 4 }}>＋</span>
          <span>{propName}</span>
        </td>
        {columns.map((col, i) => {
          if (col.kind === 'pending') {
            const change = perPlugin[col.plugin];
            return (
              <td key={`${rowKey}:p${i}`} style={{
                ...baseCell, fontStyle: 'italic',
                backgroundColor: change ? 'rgba(255,200,50,0.10)' : undefined,
                opacity: change ? 1 : 0.3,
              }}>
                {change && <AddedPendingCell change={change} editable={isEditable(col.plugin)} onStructOp={onStructOp} onRevert={onRevert} onPendingContextMenu={onPendingContextMenu} onRevealPendingChange={onRevealPendingChange} />}
              </td>
            );
          }
          return <td key={`${rowKey}:d${i}`} style={{ ...baseCell, opacity: 0.3 }} />;
        })}
      </tr>,
    );
  };

  for (const [i, s] of scripts.entries()) {
    const key = `s:${i}:${s.name}`;
    const existingNames = new Set(s.properties.map(p => p.name));
    const addsByName = pendingAddsForScript(s.name, existingNames);
    const hasProps = s.properties.length > 0 || addsByName.size > 0;
    const isExpanded = expanded.has(key);

    rows.push(
      <tr key={key}>
        <td style={headerCell}>
          {hasProps && (
            <button style={toggleBtnStyle} onClick={() => toggle(key)}>{isExpanded ? '▼' : '▶'}</button>
          )}
          {s.name}
        </td>
        {valueCells(key, s.cellStates, plugin =>
          isEditable(plugin) && onStructOp
            ? <span style={inlineCell}>
                <ScriptFlagsControl plugin={plugin} scriptName={s.name} current={s.flags[plugin] ?? null} onStructOp={onStructOp} />
                <AddPropertyButton plugin={plugin} scriptName={s.name} onStructOp={onStructOp} client={client} />
                <RemoveScriptButton plugin={plugin} scriptName={s.name} onStructOp={onStructOp} />
              </span>
            : (s.flags[plugin] ?? null))}
      </tr>,
    );

    if (hasProps && isExpanded) {
      for (const p of s.properties) pushPropertyRows(p, key, 1, s.name);
      for (const [propName, perPlugin] of addsByName) pushAddedRow(key, propName, perPlugin);
    }
  }

  for (const [name, perPlugin] of pendingScriptAdds) {
    rows.push(
      <tr key={`added-script>${name}`}>
        <td style={headerCell}>
          <span style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground, #8f8)', marginRight: 4 }}>＋</span>
          <span>{name}</span>
        </td>
        {columns.map((col, i) => {
          if (col.kind === 'pending') {
            const change = perPlugin[col.plugin];
            return (
              <td key={`as:${name}:p${i}`} style={{
                ...baseCell, fontStyle: 'italic',
                backgroundColor: change ? 'rgba(255,200,50,0.10)' : undefined,
                opacity: change ? 1 : 0.3,
              }}
              onContextMenu={change && onPendingContextMenu
                ? e => { e.preventDefault(); onPendingContextMenu(change.id, e.clientX, e.clientY); }
                : undefined}
              onClick={change && onRevealPendingChange
                ? e => { if (!e.ctrlKey && !e.metaKey) onRevealPendingChange(change.id); }
                : undefined}>
                {change && onRevert && (
                  <button onClick={e => { e.stopPropagation(); onRevert(change.id); }} title="Revert group"
                    style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)', fontSize: '11px' }}>↩</button>
                )}
              </td>
            );
          }
          return <td key={`as:${name}:d${i}`} style={{ ...baseCell, opacity: 0.3 }} />;
        })}
      </tr>,
    );
  }

  return <>{rows}</>;
}
