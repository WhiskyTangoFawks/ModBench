import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type { ConflictThis, PendingChange, VmadCompare, VmadKind, VmadPropertyDiff } from './types';
import { toStr } from './recordUtils';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle, mono, fg } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';
import { FormKeyPicker } from './FormKeyPicker';

// A VMAD structural operation payload (phase 13.8). The `op` discriminator routes the change.
export interface StructOp {
  op: string;
  [k: string]: unknown;
}

type OnStructOp = (plugin: string, vmadPath: string, op: StructOp) => void;

interface VmadSectionProps {
  vmad: VmadCompare | null | undefined;
  columns: Column[];
  onOpen: (fk: string) => void;
  editMode?: boolean;
  pendingChangeMap?: Record<string, PendingChange>;
  onEdit?: (plugin: string, vmadPath: string, value: unknown) => void;
  onRevert?: (changeId: string) => void;
  onStructOp?: OnStructOp;
  port?: number;
}

// VMAD property types that can be added (everything except Variable / ArrayOfVariable).
const ADDABLE_TYPES = [
  'Bool', 'Int', 'Float', 'String', 'Object',
  'ArrayOfBool', 'ArrayOfInt', 'ArrayOfFloat', 'ArrayOfString', 'ArrayOfObject',
  'Struct', 'ArrayOfStruct',
] as const;

function defaultOpValue(type: string): unknown {
  switch (type) {
    case 'Bool': return false;
    case 'Int': case 'Float': return 0;
    case 'String': return '';
    case 'Object': return { formKey: '', alias: -1 };
    default: return []; // arrays / struct / structList start empty
  }
}

// Scalar editor kind for a VMAD type string, or null for non-scalar types.
function opScalarKind(type: string): 'bool' | 'int' | 'float' | 'string' | null {
  if (type === 'Bool') return 'bool';
  if (type === 'Int') return 'int';
  if (type === 'Float') return 'float';
  if (type === 'String') return 'string';
  return null;
}

function isStructOp(v: unknown): v is StructOp {
  return typeof v === 'object' && v !== null && typeof (v as { op?: unknown }).op === 'string';
}

// VMAD\Script\Prop → { script, prop }; null for malformed / script-level paths.
function parseVmadPath(path: string): { script: string; prop: string } | null {
  const parts = path.split('\\');
  if (parts.length < 3 || parts[0] !== 'VMAD') return null;
  return { script: parts[1], prop: parts.slice(2).join('\\') };
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
  edit?: OnEdit;          // onEdit when in edit mode, else undefined
  leafCtx: LeafCellCtx;
  onOpen: (fk: string) => void;
}

function containerCell(plugin: string, c: RowRenderCtx, remove: React.ReactNode): React.ReactNode {
  const { p, isExpanded, edit, siblingsByPlugin, arrayVmadPath, elementType, structRootPath } = c;
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
  const { p, arrayCtx, structCtx, leafPath, typesDiffer, edit, leafCtx, onOpen } = c;
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
  const remove = c.edit && c.structCtx
    ? <StructRemoveButton plugin={plugin} structCtx={c.structCtx} onEdit={c.edit} />
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
  return (
    <span style={inlineCell}>
      {editor}
      <button
        title="Remove element"
        onClick={() => onEdit(plugin, arrayCtx.vmadPath, siblings.filter((_, j) => j !== arrayCtx.index))}
        style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
      >×</button>
    </span>
  );
}

type OnEdit = (plugin: string, vmadPath: string, value: unknown) => void;

interface LeafCellCtx {
  editMode?: boolean;
  onEdit?: OnEdit;
  port?: number;
  onOpen: (fk: string) => void;
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
  const { editMode, onEdit, port, onOpen } = ctx;
  const typeCue = typesDiffer ? `(${p.types[plugin]})` : null;
  if (!editMode || !onEdit) return leafContent(p, plugin, onOpen, typeCue);

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

  if (p.kind === 'scalar') return <VmadScalarEditor value={p.values[plugin]} type={scalarType(p)} onCommit={commit} />;
  if (p.kind === 'object' && port != null) return <VmadObjectEditor value={p.values[plugin]} port={port} onCommit={commit} />;
  return leafContent(p, plugin, onOpen, typeCue);
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
        <FormKeyLink value={fk} onOpen={onOpen} />
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

interface VmadScalarEditorProps {
  value: unknown;
  type: 'bool' | 'int' | 'float' | 'string';
  onCommit: (v: unknown) => void;
  ariaLabel?: string;
}

function VmadScalarEditor({ value, type, onCommit, ariaLabel }: Readonly<VmadScalarEditorProps>) {
  const [draft, setDraft] = useState(() => toStr(value));
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(toStr(value));
  }

  if (type === 'bool') {
    return (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={draft === 'true'}
        onChange={e => { setDraft(String(e.target.checked)); onCommit(e.target.checked); }}
      />
    );
  }

  function coerce(): unknown {
    if (type === 'int') { const n = Number.parseInt(draft, 10); return Number.isNaN(n) ? value : n; }
    if (type === 'float') { const n = Number.parseFloat(draft); return Number.isNaN(n) ? value : n; }
    return draft;
  }

  const inputStyle: React.CSSProperties = {
    fontFamily: mono,
    fontSize: '12px',
    background: 'var(--vscode-input-background, #3c3c3c)',
    color: fg,
    border: '1px solid var(--vscode-input-border, #555)',
    padding: '1px 4px',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <input
      type={type === 'int' || type === 'float' ? 'number' : 'text'}
      aria-label={ariaLabel}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => onCommit(coerce())}
      onKeyDown={e => { if (e.key === 'Enter') { onCommit(coerce()); (e.target as HTMLInputElement).blur(); } }}
      style={inputStyle}
    />
  );
}

const OBJ_RE = /^(.+?)\s*\[(-?\d+)\]\s*$/;

interface VmadObjectEditorProps {
  value: unknown;
  port: number;
  onCommit: (v: { formKey: string; alias: number }) => void;
}

function VmadObjectEditor({ value, port, onCommit }: Readonly<VmadObjectEditorProps>) {
  const str = typeof value === 'string' ? value : '';
  const m = OBJ_RE.exec(str);
  const diskFk = m ? m[1].trim() : str;
  const diskAlias = m ? Number(m[2]) : -1;

  const [pendingFk, setPendingFk] = useState(diskFk);
  const [alias, setAlias] = useState(diskAlias);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) { setPrevValue(value); setPendingFk(diskFk); setAlias(diskAlias); }

  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <FormKeyPicker
        port={port}
        validTypes={[]}
        onSelect={fk => { setPicking(false); setPendingFk(fk); onCommit({ formKey: fk, alias }); }}
        onClose={() => setPicking(false)}
      />
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => setPicking(true)}
        style={{
          background: 'var(--vscode-input-background, #3c3c3c)',
          border: '1px solid var(--vscode-input-border, #555)',
          color: pendingFk ? 'var(--vscode-textLink-foreground, #3794ff)' : fg,
          cursor: 'pointer',
          fontFamily: mono,
          fontSize: '12px',
          padding: '1px 4px',
          textAlign: 'left',
        }}
      >
        {pendingFk || <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>
      <input
        type="number"
        value={alias}
        onChange={e => setAlias(Number(e.target.value))}
        onBlur={() => onCommit({ formKey: pendingFk, alias })}
        aria-label="Alias"
        style={{ width: 50, fontFamily: mono, fontSize: '12px' }}
      />
    </span>
  );
}

// ── structural ops (13.8): add / remove property ───────────────────────────────

const structBtnStyle: React.CSSProperties = {
  ...iconBtnStyle, fontSize: '14px', padding: '0 4px', color: fg,
};

const dialogInputStyle: React.CSSProperties = {
  fontFamily: mono, fontSize: '12px',
  background: 'var(--vscode-input-background, #3c3c3c)', color: fg,
  border: '1px solid var(--vscode-input-border, #555)', padding: '2px 6px',
};

// Shared modal chrome for the add-property / add-script dialogs (fixed overlay + title + footer).
function ModalShell({ title, confirmDisabled, onConfirm, onCancel, children }: Readonly<{
  title: string; confirmDisabled?: boolean; onConfirm: () => void; onCancel: () => void; children: React.ReactNode;
}>) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--vscode-editor-background, #1e1e1e)', border: '1px solid var(--vscode-editorGroup-border, #444)', padding: 12, minWidth: 280 }}>
        <div style={{ fontFamily: mono, fontSize: '12px', marginBottom: 8 }}>{title}</div>
        <table><tbody>{children}</tbody></table>
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button onClick={onCancel} style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} disabled={confirmDisabled}
            style={{ fontSize: '11px', padding: '2px 8px', cursor: 'pointer', background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)', border: 'none' }}>Add</button>
        </div>
      </div>
    </div>
  );
}

function AddPropertyDialog({ port, onConfirm, onCancel }: Readonly<{
  port?: number;
  onConfirm: (v: { name: string; type: string; value: unknown }) => void;
  onCancel: () => void;
}>) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('Int');
  const [value, setValue] = useState<unknown>(() => defaultOpValue('Int'));
  const [picking, setPicking] = useState(false);

  function changeType(t: string) { setType(t); setValue(defaultOpValue(t)); }

  const kind = opScalarKind(type);
  const inputStyle = dialogInputStyle;

  function valueControl(): React.ReactNode {
    if (kind === 'bool') {
      return <input type="checkbox" aria-label="New property value"
        checked={value === true} onChange={e => setValue(e.target.checked)} />;
    }
    if (kind != null) {
      return (
        <input
          type={kind === 'int' || kind === 'float' ? 'number' : 'text'}
          aria-label="New property value"
          style={inputStyle}
          onChange={e => {
            const s = e.target.value;
            if (kind === 'int') { const n = Number.parseInt(s, 10); setValue(Number.isNaN(n) ? 0 : n); return; }
            if (kind === 'float') { const n = Number.parseFloat(s); setValue(Number.isNaN(n) ? 0 : n); return; }
            setValue(s);
          }}
        />
      );
    }
    if (type === 'Object' && port != null) {
      const fk = (value as { formKey?: string }).formKey ?? '';
      if (picking) {
        return (
          <FormKeyPicker port={port} validTypes={[]}
            onSelect={f => { setValue({ formKey: f, alias: -1 }); setPicking(false); }}
            onClose={() => setPicking(false)} />
        );
      }
      return <button aria-label="New property value" style={inputStyle} onClick={() => setPicking(true)}>
        {fk || <span style={{ opacity: 0.5 }}>— click to pick</span>}
      </button>;
    }
    return <span style={{ opacity: 0.5 }}>(empty)</span>;
  }

  return (
    <ModalShell title="Add property" confirmDisabled={name.trim() === ''}
      onCancel={onCancel} onConfirm={() => onConfirm({ name, type, value })}>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Name</td>
        <td><input aria-label="New property name" style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Type</td>
        <td><select aria-label="New property type" style={inputStyle} value={type} onChange={e => changeType(e.target.value)}>
          {ADDABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Value</td><td>{valueControl()}</td></tr>
    </ModalShell>
  );
}

function AddPropertyButton({ plugin, scriptName, onStructOp, port }: Readonly<{
  plugin: string; scriptName: string; onStructOp: OnStructOp; port?: number;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button title="Add property" onClick={() => setOpen(true)} style={structBtnStyle}>+ prop</button>
      {open && (
        <AddPropertyDialog
          port={port}
          onCancel={() => setOpen(false)}
          onConfirm={({ name, type, value }) => {
            setOpen(false);
            onStructOp(plugin, `VMAD\\${scriptName}\\${name}`,
              { op: 'add_property', type, name, flags: 'Edited', value });
          }}
        />
      )}
    </>
  );
}

function RemovePropertyButton({ plugin, scriptName, propName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; onStructOp: OnStructOp;
}>) {
  return (
    <button
      title="Remove property"
      onClick={() => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'remove_property' })}
      style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
    >×</button>
  );
}

// Type dropdown (13.8.3) — changing it stages set_type, which resets the value on the backend.
function SetTypeControl({ plugin, scriptName, propName, currentType, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; currentType: string; onStructOp: OnStructOp;
}>) {
  const known = (ADDABLE_TYPES as readonly string[]).includes(currentType);
  return (
    <select
      aria-label={`Type for ${propName}`}
      title="Changing type resets the value"
      value={known ? currentType : ''}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'set_type', type: e.target.value })}
      style={{ ...dialogInputStyle, fontSize: '11px' }}
    >
      {!known && <option value="">{currentType || '—'}</option>}
      {ADDABLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
    </select>
  );
}

const PROP_FLAGS = ['Edited', 'Removed'] as const;

const flagSelectStyle: React.CSSProperties = { ...dialogInputStyle, fontSize: '11px' };

// Script flags control (13.8.4) — reflects the current per-plugin flag, stages set_flags on change.
function ScriptFlagsControl({ plugin, scriptName, current, onStructOp }: Readonly<{
  plugin: string; scriptName: string; current: string | null; onStructOp: OnStructOp;
}>) {
  const val = current && (SCRIPT_FLAGS as readonly string[]).includes(current) ? current : 'Local';
  return (
    <select aria-label={`Flags for ${scriptName}`} value={val} style={flagSelectStyle}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}`, { op: 'set_flags', flags: e.target.value })}>
      {SCRIPT_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  );
}

// Property flags control (13.8.4). The read model carries no per-property flag, so this is set-only
// (defaults to Edited) — staging set_flags applies the chosen value on save.
function PropertyFlagsControl({ plugin, scriptName, propName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; propName: string; onStructOp: OnStructOp;
}>) {
  return (
    <select aria-label={`Flags for ${propName}`} defaultValue="Edited" style={flagSelectStyle}
      onChange={e => onStructOp(plugin, `VMAD\\${scriptName}\\${propName}`, { op: 'set_flags', flags: e.target.value })}>
      {PROP_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  );
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
function AddedPendingCell({ change, editMode, onStructOp, onRevert }: Readonly<{
  change: PendingChange; editMode?: boolean; onStructOp?: OnStructOp; onRevert?: (id: string) => void;
}>) {
  const op = change.newValue as StructOp & { type: string; name: string; value: unknown };
  const kind = opScalarKind(op.type);
  const reissue = (v: unknown) => onStructOp?.(change.plugin, change.fieldPath, { ...op, value: v });
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {editMode && onStructOp && kind
        ? <VmadScalarEditor value={op.value} type={kind} onCommit={reissue} ariaLabel={`Added value for ${op.name}`} />
        : <span>{toStr(op.value)}</span>}
      {onRevert && (
        <button onClick={() => onRevert(change.id)} title="Revert this change"
          style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)', fontSize: '11px' }}>↩</button>
      )}
    </span>
  );
}

// ── structural ops (13.8.2): add / remove script ───────────────────────────────

const SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;

// VMAD\<ScriptName> (no property segment) → script name; null otherwise.
function parseVmadScriptPath(path: string): string | null {
  const parts = path.split('\\');
  return parts.length === 2 && parts[0] === 'VMAD' ? parts[1] : null;
}

function AddScriptDialog({ onConfirm, onCancel }: Readonly<{
  onConfirm: (v: { name: string; flags: string }) => void; onCancel: () => void;
}>) {
  const [name, setName] = useState('');
  const [flags, setFlags] = useState<string>('Local');
  return (
    <ModalShell title="Add script" confirmDisabled={name.trim() === ''}
      onCancel={onCancel} onConfirm={() => onConfirm({ name, flags })}>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Name</td>
        <td><input aria-label="New script name" style={dialogInputStyle} value={name} onChange={e => setName(e.target.value)} /></td></tr>
      <tr><td style={{ paddingRight: 6, opacity: 0.7 }}>Flags</td>
        <td><select aria-label="New script flags" style={dialogInputStyle} value={flags} onChange={e => setFlags(e.target.value)}>
          {SCRIPT_FLAGS.map(f => <option key={f} value={f}>{f}</option>)}
        </select></td></tr>
    </ModalShell>
  );
}

function AddScriptButton({ plugin, onStructOp }: Readonly<{ plugin: string; onStructOp: OnStructOp }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button title="Add script" onClick={() => setOpen(true)} style={structBtnStyle}>+ script</button>
      {open && (
        <AddScriptDialog
          onCancel={() => setOpen(false)}
          onConfirm={({ name, flags }) => {
            setOpen(false);
            onStructOp(plugin, `VMAD\\${name}`, { op: 'add_script', name, flags, properties: [] });
          }}
        />
      )}
    </>
  );
}

function RemoveScriptButton({ plugin, scriptName, onStructOp }: Readonly<{
  plugin: string; scriptName: string; onStructOp: OnStructOp;
}>) {
  return (
    <button
      title="Remove script"
      onClick={() => onStructOp(plugin, `VMAD\\${scriptName}`, { op: 'remove_script' })}
      style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
    >×</button>
  );
}

// ── VmadSection ────────────────────────────────────────────────────────────────

export function VmadSection({
  vmad, columns, onOpen,
  editMode, pendingChangeMap, onEdit, onRevert, onStructOp, port,
}: Readonly<VmadSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scripts = vmad?.scripts ?? [];
  const showAddScript = editMode === true && onStructOp != null;

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
          >
            {hasPending && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {pendingOpLabel(change.newValue)}
                {onRevert && (
                  <button
                    onClick={() => onRevert(change.id)}
                    title="Revert this change"
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
        {columns.map((col, i) => col.kind === 'pending'
          ? <td key={`add-script:p${i}`} style={baseCell} />
          : <td key={`add-script:d${i}`} style={baseCell}><AddScriptButton plugin={col.override.plugin} onStructOp={onStructOp} /></td>)}
      </tr>,
    );
  }

  const leafCtx: LeafCellCtx = { editMode, onEdit, port, onOpen };

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
      edit: editMode === true ? onEdit : undefined, leafCtx, onOpen,
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
          depth === 1 && editMode && onStructOp
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
                {change && <AddedPendingCell change={change} editMode={editMode} onStructOp={onStructOp} onRevert={onRevert} />}
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
          editMode && onStructOp
            ? <span style={inlineCell}>
                <ScriptFlagsControl plugin={plugin} scriptName={s.name} current={s.flags[plugin] ?? null} onStructOp={onStructOp} />
                <AddPropertyButton plugin={plugin} scriptName={s.name} onStructOp={onStructOp} port={port} />
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
              }}>
                {change && onRevert && (
                  <button onClick={() => onRevert(change.id)} title="Revert this change"
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
