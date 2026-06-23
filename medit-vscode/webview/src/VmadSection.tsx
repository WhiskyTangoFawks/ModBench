import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type { ConflictThis, PendingChange, VmadCompare, VmadKind, VmadPropertyDiff } from './types';
import { toStr } from './recordUtils';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle, mono, fg } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';
import { FormKeyPicker } from './FormKeyPicker';

interface VmadSectionProps {
  vmad: VmadCompare | null | undefined;
  columns: Column[];
  onOpen: (fk: string) => void;
  editMode?: boolean;
  pendingChangeMap?: Record<string, PendingChange>;
  onEdit?: (plugin: string, vmadPath: string, value: unknown) => void;
  onRevert?: (changeId: string) => void;
  port?: number;
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
  const t = p.types[p.winnerPlugin] ?? '';
  if (t === 'Bool') return 'bool';
  if (t === 'Int') return 'int';
  if (t === 'Float') return 'float';
  return 'string';
}

interface VmadScalarEditorProps {
  value: unknown;
  type: 'bool' | 'int' | 'float' | 'string';
  onCommit: (v: unknown) => void;
}

function VmadScalarEditor({ value, type, onCommit }: Readonly<VmadScalarEditorProps>) {
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

// ── VmadSection ────────────────────────────────────────────────────────────────

export function VmadSection({
  vmad, columns, onOpen,
  editMode, pendingChangeMap, onEdit, onRevert, port,
}: Readonly<VmadSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!vmad || vmad.scripts.length === 0) return null;

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
                <span>{toStr(change.newValue)}</span>
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
        {valueCells(key, p.cellStates, plugin => propertyCell(plugin, rowCtx), arrayVmadPath ?? leafPath ?? structRootPath)}
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

  for (const [i, s] of vmad.scripts.entries()) {
    const key = `s:${i}:${s.name}`;
    const hasProps = s.properties.length > 0;
    const isExpanded = expanded.has(key);

    rows.push(
      <tr key={key}>
        <td style={headerCell}>
          {hasProps && (
            <button style={toggleBtnStyle} onClick={() => toggle(key)}>{isExpanded ? '▼' : '▶'}</button>
          )}
          {s.name}
        </td>
        {valueCells(key, s.cellStates, plugin => s.flags[plugin] ?? null)}
      </tr>,
    );

    if (hasProps && isExpanded) {
      for (const p of s.properties) pushPropertyRows(p, key, 1, s.name);
    }
  }

  return <>{rows}</>;
}
