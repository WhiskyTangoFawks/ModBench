import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type { ConflictThis, VmadCompare, VmadKind, VmadPropertyDiff } from './types';
import { toStr } from './recordUtils';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';

interface VmadSectionProps {
  vmad: VmadCompare | null | undefined;
  columns: Column[];
  onOpen: (fk: string) => void;
}

function isContainerKind(kind: VmadKind): kind is 'array' | 'struct' | 'structList' {
  return kind === 'array' || kind === 'struct' || kind === 'structList';
}

// True when any descendant of `p` carries data for `plugin` — used to decide
// whether a collapsed container cell shows a summary for that plugin's column.
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

// Renders a single property's leaf value for one plugin column. Object values
// arrive from the backend as "FormKey [Alias]" — the FormKey becomes a link.
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
    const m = /^(.+?)\s*(\[.*\])\s*$/.exec(str);
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

export function VmadSection({ vmad, columns, onOpen }: Readonly<VmadSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!vmad || vmad.scripts.length === 0) return null;

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalCols = columns.length + 1; // +1 for the leftmost "Field" column

  // Renders the per-plugin value cells (disk columns coloured, pending columns blank).
  const valueCells = (
    rowKey: string,
    cellStates: Record<string, ConflictThis | undefined>,
    render: (plugin: string) => React.ReactNode,
  ): React.ReactNode[] =>
    columns.map((col, i) => {
      if (col.kind === 'pending') return <td key={`${rowKey}:p${i}`} style={baseCell} />;
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

  const pushPropertyRows = (p: VmadPropertyDiff, parentKey: string, depth: number) => {
    const key = `${parentKey}>${p.name}`;
    const isContainer = isContainerKind(p.kind);
    const hasChildren = isContainer && (p.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(key);

    const typeVals = Object.values(p.types);
    const typesDiffer = typeVals.length > 1 && typeVals.some(t => t !== typeVals[0]);

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
          return leafContent(p, plugin, onOpen, typesDiffer ? `(${p.types[plugin]})` : null);
        })}
      </tr>,
    );

    if (hasChildren && isExpanded) {
      for (const c of p.children ?? []) pushPropertyRows(c, key, depth + 1);
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
      for (const p of s.properties) pushPropertyRows(p, key, 1);
    }
  }

  return <>{rows}</>;
}
