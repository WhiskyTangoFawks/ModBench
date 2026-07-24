import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type {
  ConditionCompare, ConditionDiff, ConditionOperator, ConflictThis,
  ParsedCondition, ParsedConditionParam,
} from './types';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';

// Read-only compare view for a record's conditions (CTDA), mirroring VmadSection's grid shape.
// Each condition renders as a collapsed xEdit-style summary row with two-axis conflict coloring
// (ADR-0016), expandable to its typed fields. Display only — editing is a later slice (ADR-0032).

const OPERATOR_SYMBOL: Record<ConditionOperator, string> = {
  EqualTo: '=',
  NotEqualTo: '<>',
  GreaterThan: '>',
  GreaterThanOrEqualTo: '>=',
  LessThan: '<',
  LessThanOrEqualTo: '<=',
};

function paramText(p: ParsedConditionParam): string {
  if (p.category === 'Form') return p.formKey ?? '';
  if (p.category === 'Text') return p.text ?? '';
  return String(p.number ?? 0);
}

function comparisonText(c: ParsedCondition): string {
  if (c.useGlobal) return c.comparisonGlobal ?? '';
  return String(c.comparisonFloat ?? 0);
}

// The one-line summary, matching xEdit's wbConditionToStr shape closely enough to be recognizable:
// `RunOn.Function(p1, p2) <op> value AND|OR`.
function conditionSummary(c: ParsedCondition): string {
  const run = c.runOnTarget === 'Reference' && c.runOnReference ? `(${c.runOnReference})` : c.runOnTarget;
  const params = c.parameters.map(paramText).join(', ');
  const call = params ? `${c.function}(${params})` : c.function;
  return `${run}.${call} ${OPERATOR_SYMBOL[c.operator]} ${comparisonText(c)} ${c.or ? 'OR' : 'AND'}`;
}

function rowHasConflict(cellStates: Record<string, ConflictThis>): boolean {
  return Object.values(cellStates).some(s => s === 'ConflictWins' || s === 'ConflictLoses');
}

// One expandable field of a condition, rendered per plugin. Form-typed values become FormKey links.
// `key` matches the backend's FieldCellStates id so the row colors on its own two-axis state.
interface FieldSpec {
  key: string;
  label: string;
  render: (c: ParsedCondition, onOpen: (fk: string) => void) => React.ReactNode;
}

function value(text: string): React.ReactNode {
  return text ? <span>{text}</span> : <span style={{ opacity: 0.35 }}>—</span>;
}

function link(fk: string | null | undefined, onOpen: (fk: string) => void): React.ReactNode {
  return fk ? <FormKeyLink value={fk} onOpen={onOpen} /> : value('');
}

function paramField(index: number): FieldSpec {
  return {
    key: `param:${index}`,
    label: `Parameter ${index + 1}`,
    render: (c, onOpen) => {
      const p = c.parameters[index];
      if (!p) return value('');
      const typeCue = <span style={{ opacity: 0.6 }}>&nbsp;({p.typeName})</span>;
      const body = p.category === 'Form' ? link(p.formKey, onOpen) : value(paramText(p));
      return <span>{body}{typeCue}</span>;
    },
  };
}

// Field rows shown when a condition is expanded. Parameter rows are appended per condition (their
// count varies), so this covers only the fixed envelope.
const ENVELOPE_FIELDS: FieldSpec[] = [
  { key: 'function', label: 'Function', render: c => value(c.function) },
  { key: 'runOn', label: 'Run On', render: (c, onOpen) => c.runOnTarget === 'Reference'
      ? <span>Reference:&nbsp;{link(c.runOnReference, onOpen)}</span>
      : value(c.runOnTarget) },
  { key: 'operator', label: 'Operator', render: c => value(OPERATOR_SYMBOL[c.operator]) },
  { key: 'comparison', label: 'Comparison', render: (c, onOpen) => c.useGlobal
      ? link(c.comparisonGlobal, onOpen)
      : value(String(c.comparisonFloat ?? 0)) },
  { key: 'gate', label: 'Type', render: c => value(c.or ? 'OR' : 'AND') },
];

function fieldsFor(condition: ConditionDiff): FieldSpec[] {
  const maxParams = Math.max(
    0,
    ...Object.values(condition.perPlugin).map(c => c?.parameters.length ?? 0),
  );
  const paramFields = Array.from({ length: maxParams }, (_, i) => paramField(i));
  // Function, Parameters…, then the rest of the envelope — matching the summary's left-to-right order.
  return [ENVELOPE_FIELDS[0], ...paramFields, ...ENVELOPE_FIELDS.slice(1)];
}

function dash(): React.ReactNode {
  return <span style={{ opacity: 0.35 }}>—</span>;
}

function perPluginCells(
  columns: Column[],
  rowKey: string,
  cellStates: Record<string, ConflictThis>,
  render: (plugin: string) => React.ReactNode,
): React.ReactNode[] {
  return columns.map((col, i) => {
    if (col.kind === 'pending') return <td key={`${rowKey}:p${i}`} style={{ ...baseCell, opacity: 0.3 }} />;
    const plugin = col.override.plugin;
    return (
      <td key={`${rowKey}:d${i}`} style={{ ...baseCell, ...getCellStyle(cellStates[plugin]) }}>
        {render(plugin)}
      </td>
    );
  });
}

// The summary row plus, when expanded, one two-axis-colored row per field.
function conditionRows(
  condition: ConditionDiff,
  key: string,
  isExpanded: boolean,
  columns: Column[],
  onOpen: (fk: string) => void,
  toggle: (key: string) => void,
): React.ReactNode[] {
  const labelStyle: React.CSSProperties = {
    ...baseCell,
    paddingLeft: 8,
    ...(rowHasConflict(condition.cellStates) ? getCellStyle('ConflictWins') : {}),
  };

  const rows: React.ReactNode[] = [
    <tr key={key}>
      <td style={labelStyle}>
        <button style={toggleBtnStyle} onClick={() => toggle(key)}>{isExpanded ? '▼' : '▶'}</button>
        {`#${condition.index + 1}`}
      </td>
      {perPluginCells(columns, key, condition.cellStates, plugin => {
        const c = condition.perPlugin[plugin];
        return c ? <span>{conditionSummary(c)}</span> : dash();
      })}
    </tr>,
  ];

  if (!isExpanded) return rows;

  for (const field of fieldsFor(condition)) {
    const fieldKey = `${key}>${field.label}`;
    // Absent key = that field is identical across plugins → no coloring (never fall back to the
    // whole-condition state, which would recolor every field when only one differs).
    const states = condition.fieldCellStates[field.key] ?? {};
    rows.push(
      <tr key={fieldKey}>
        <td style={{ ...baseCell, paddingLeft: 28, opacity: 0.85 }}>{field.label}</td>
        {perPluginCells(columns, fieldKey, states, plugin => {
          const c = condition.perPlugin[plugin];
          return c ? field.render(c, onOpen) : dash();
        })}
      </tr>,
    );
  }
  return rows;
}

interface ConditionSectionProps {
  conditions: ConditionCompare | null | undefined;
  columns: Column[];
  onOpen: (fk: string) => void;
}

export function ConditionSection({
  conditions, columns, onOpen,
}: Readonly<ConditionSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = conditions?.groups ?? [];
  if (groups.length === 0) return null;

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const rows: React.ReactNode[] = [
    <tr key="conditions-header">
      <td colSpan={columns.length + 1} style={headerCell}>Conditions</td>
    </tr>,
  ];

  for (const group of groups) {
    for (const condition of group.conditions) {
      const key = `${group.fieldPath}#${condition.index}`;
      rows.push(...conditionRows(condition, key, expanded.has(key), columns, onOpen, toggle));
    }
  }

  return <>{rows}</>;
}
