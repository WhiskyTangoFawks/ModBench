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

function isContainerKind(kind: VmadKind): kind is 'array' | 'struct' | 'structList' {
  return kind === 'array' || kind === 'struct' || kind === 'structList';
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

  const pushPropertyRows = (p: VmadPropertyDiff, parentKey: string, depth: number, scriptName: string) => {
    const key = `${parentKey}>${p.name}`;
    const isContainer = isContainerKind(p.kind);
    const hasChildren = isContainer && (p.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(key);

    const typeVals = Object.values(p.types);
    const typesDiffer = typeVals.length > 1 && typeVals.some(t => t !== typeVals[0]);

    const vmadPath = depth === 1 && !isContainer ? `VMAD\\${scriptName}\\${p.name}` : undefined;

    rows.push(
      <tr key={key}>
        <td style={{ ...baseCell, paddingLeft: 8 + depth * 16, opacity: 0.85 }}>
          {hasChildren && (
            <button style={toggleBtnStyle} onClick={() => toggle(key)}>{isExpanded ? '▼' : '▶'}</button>
          )}
          {p.name}
        </td>
        {valueCells(key, p.cellStates, plugin => {
          if (isContainer) {
            if (isExpanded) return null;
            return hasPluginData(p, plugin) ? containerSummary(p) : null;
          }
          if (editMode && onEdit && vmadPath) {
            if (p.kind === 'scalar') {
              const type = scalarType(p);
              return <VmadScalarEditor value={p.values[plugin]} type={type} onCommit={v => onEdit(plugin, vmadPath, v)} />;
            }
            if (p.kind === 'object' && port != null) {
              return <VmadObjectEditor value={p.values[plugin]} port={port} onCommit={v => onEdit(plugin, vmadPath, v)} />;
            }
          }
          return leafContent(p, plugin, onOpen, typesDiffer ? `(${p.types[plugin]})` : null);
        }, vmadPath)}
      </tr>,
    );

    if (hasChildren && isExpanded) {
      for (const c of p.children ?? []) pushPropertyRows(c, key, depth + 1, scriptName);
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
