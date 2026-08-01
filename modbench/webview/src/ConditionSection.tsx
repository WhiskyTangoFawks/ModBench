import React, { useState } from 'react';
import type { Column } from './recordUtils';
import type {
  ConditionCompare, ConditionDiff, ConditionOperator, ConflictThis, FieldMetadata,
  ParsedCondition, ParsedConditionParam, PendingChange,
} from './types';
import { baseCell, headerCell, toggleBtnStyle, getCellStyle } from './gridStyles';
import { FormKeyLink } from './FormKeyLink';
import { FormKeyCell } from './FormKeyCell';
import { ScalarCell } from './ScalarCell';
import { ConditionFunctionPicker } from './ConditionFunctionPicker';
import { CONDITION_SUBFIELD_WIRE, conditionFieldPath, conditionParamPath } from './conditionPath';
import { applyConditionListOp, currentConditionList, overlayPendingEdits } from './conditionOps';
import type { RecordSessionClient } from './RecordSessionClient';

// Compare view for a record's conditions (CTDA), mirroring VmadSection's grid shape. Each
// condition renders as a collapsed xEdit-style summary row with two-axis conflict coloring
// (ADR-0016), expandable to its typed fields. Fields stage through the ordinary onEdit pending-
// change path (#152) — the same mechanism every other scalar field in this app uses (ScalarCell /
// FormKeyCell) — except the AND/OR logic gate, left read-only (deferred with add/remove/reorder,
// #150's arity/order slice).

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
};

const OPERATOR_SYMBOL: Record<ConditionOperator, string> = {
  EqualTo: '=',
  NotEqualTo: '<>',
  GreaterThan: '>',
  GreaterThanOrEqualTo: '>=',
  LessThan: '<',
  LessThanOrEqualTo: '<=',
};

const OPERATOR_VALUES: ConditionOperator[] = [
  'EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo',
];

// Condition.RunOnType names (Fallout4ConditionCodec's game-neutral RunOnTarget strings).
const RUN_ON_TARGETS = [
  'Subject', 'Target', 'Reference', 'CombatTarget', 'LinkedReference', 'QuestAlias',
  'PackageData', 'EventData', 'CommandTarget', 'EventCameraRef', 'MyKiller',
];

function enumMeta(enumValues: string[]): FieldMetadata {
  return { name: '', type: 'enum', isArray: false, validFormKeyTypes: [], enumValues };
}
function scalarMeta(type: 'int' | 'float' | 'string' | 'bool'): FieldMetadata {
  return { name: '', type, isArray: false, validFormKeyTypes: [], enumValues: [] };
}
function formKeyMeta(validFormKeyTypes: string[] = []): FieldMetadata {
  return { name: '', type: 'formKey', isArray: false, validFormKeyTypes, enumValues: [] };
}

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

// Bound to one field's own wire path — editors just call onCommit(value) like any ScalarCell/
// FormKeyCell in the rest of the grid.
interface FieldEditCtx {
  client: RecordSessionClient;
  onOpen: (fk: string) => void;
  onCommit: (value: unknown) => void;
}

// One expandable field of a condition, rendered per plugin. `key` matches the backend's
// FieldCellStates id so the row colors on its own two-axis state, and (via wirePathFor) names the
// ConditionPath sub-field this row edits.
interface FieldSpec {
  key: string;
  label: string;
  render: (c: ParsedCondition, onOpen: (fk: string) => void) => React.ReactNode;
  renderEdit?: (c: ParsedCondition, ctx: FieldEditCtx) => React.ReactNode;
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
    // Changing a condition's function reshapes this row's whole shape: the parameter's category is
    // read fresh from the *new* ParsedCondition after a Function edit round-trips (the backend
    // recomputes each slot from the new function's GetParameterTypes and resets stale slots —
    // Fallout4ConditionCodec.ApplyFieldValue), so a stale value from the old function's shape never
    // renders through the wrong-typed input here.
    renderEdit: (c, ctx) => {
      const p = c.parameters[index];
      if (!p) return null;
      if (p.category === 'Form') {
        return (
          <FormKeyCell value={p.formKey} meta={formKeyMeta()} editable
            client={ctx.client} onOpen={ctx.onOpen} onCommit={ctx.onCommit} />
        );
      }
      if (p.category === 'Text') {
        return <ScalarCell value={p.text ?? ''} meta={scalarMeta('string')} editable onCommit={ctx.onCommit} />;
      }
      return <ScalarCell value={p.number ?? 0} meta={scalarMeta('int')} editable onCommit={ctx.onCommit} />;
    },
  };
}

// Field rows shown when a condition is expanded. Parameter rows are appended per condition (their
// count varies), so this covers only the fixed envelope. `gate` (AND/OR) has no renderEdit —
// grouping edits are out of scope for #152 (grouped with add/remove/reorder in a later slice).
const ENVELOPE_FIELDS: FieldSpec[] = [
  {
    key: 'function',
    label: 'Function',
    render: c => value(c.function),
    renderEdit: (c, ctx) => <ConditionFunctionPicker value={c.function} client={ctx.client} onCommit={ctx.onCommit} />,
  },
  {
    key: 'runOn',
    label: 'Run On',
    render: (c, onOpen) => c.runOnTarget === 'Reference'
      ? <span>Reference:&nbsp;{link(c.runOnReference, onOpen)}</span>
      : value(c.runOnTarget),
    renderEdit: (c, ctx) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ScalarCell
          value={c.runOnTarget}
          meta={enumMeta(RUN_ON_TARGETS)}
          editable
          onCommit={v => ctx.onCommit({ target: v, reference: v === 'Reference' ? (c.runOnReference ?? null) : null })}
        />
        {c.runOnTarget === 'Reference' && (
          <FormKeyCell
            value={c.runOnReference}
            meta={formKeyMeta()}
            editable
            client={ctx.client}
            onOpen={ctx.onOpen}
            onCommit={fk => ctx.onCommit({ target: c.runOnTarget, reference: fk })}
          />
        )}
      </span>
    ),
  },
  {
    key: 'operator',
    label: 'Operator',
    render: c => value(OPERATOR_SYMBOL[c.operator]),
    renderEdit: (c, ctx) => <ScalarCell value={c.operator} meta={enumMeta(OPERATOR_VALUES)} editable onCommit={ctx.onCommit} />,
  },
  {
    key: 'useGlobal',
    label: 'Use Global',
    render: c => value(c.useGlobal ? 'Yes' : 'No'),
    renderEdit: (c, ctx) => <ScalarCell value={c.useGlobal} meta={scalarMeta('bool')} editable onCommit={ctx.onCommit} />,
  },
  {
    key: 'comparison',
    label: 'Comparison',
    render: (c, onOpen) => c.useGlobal
      ? link(c.comparisonGlobal, onOpen)
      : value(String(c.comparisonFloat ?? 0)),
    // Which input renders is read straight from the *current* useGlobal value (AC3) — no local
    // toggle state to desync from the staged/refetched condition.
    renderEdit: (c, ctx) => c.useGlobal
      ? (
        <FormKeyCell
          value={c.comparisonGlobal}
          meta={formKeyMeta(['glob'])}
          editable
          client={ctx.client}
          onOpen={ctx.onOpen}
          onCommit={ctx.onCommit}
        />
      )
      : <ScalarCell value={c.comparisonFloat ?? 0} meta={scalarMeta('float')} editable onCommit={ctx.onCommit} />,
  },
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

// The ConditionPath wire path (Edits/ConditionPath.cs) this field's edits stage at, or null for a
// field with no renderEdit (currently only `gate`).
function wirePathFor(groupFieldPath: string, index: number, key: string): string | null {
  const paramMatch = /^param:(\d+)$/.exec(key);
  if (paramMatch) return conditionParamPath(groupFieldPath, index, Number(paramMatch[1]));
  return CONDITION_SUBFIELD_WIRE[key] ? conditionFieldPath(groupFieldPath, index, CONDITION_SUBFIELD_WIRE[key]) : null;
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

function pendingValueText(v: unknown): string {
  if (v && typeof v === 'object' && 'target' in (v as Record<string, unknown>)) {
    return String((v as { target: unknown }).target);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// All section-level edit plumbing, bundled so row builders stay simple. Mirrors VmadSection's
// convention: immutableSet is required (fail-closed — see VmadSectionProps), everything else that
// only matters once editing is wired is optional.
interface SectionCtx {
  columns: Column[];
  onOpen: (fk: string) => void;
  toggle: (key: string) => void;
  isEditable: (plugin: string) => boolean;
  onEdit?: (plugin: string, path: string, value: unknown) => void;
  client?: RecordSessionClient;
  pendingChangeMap?: Record<string, PendingChange>;
  // Issue #139/#203: right-click a pending value → Save Group / Revert Group / Reveal in Pending
  // Changes Tree, all from the shared PendingCellMenu RecordPanel owns.
  onPendingContextMenu?: (changeId: string, x: number, y: number) => void;
}

// Issue #203: a pending condition field is directly editable, on the same terms as a disk cell —
// same field.renderEdit widget the disk cell uses (ScalarCell/FormKeyCell/etc, each already
// click-to-activate on its own), fed a condition overlaid with every staged field for this
// condition+plugin rather than just the one being rendered. Overlaying only the rendered field
// would be wrong the moment two fields are staged together on one condition: Comparison's editor
// reads UseGlobal to pick FormKeyCell vs ScalarCell, so a stale (non-overlaid) UseGlobal would
// show/commit through the wrong widget even though UseGlobal's own pending change is sitting
// right there in the same map (overlayPendingEdits, conditionOps.ts).
//
// Editable is unconditional (no immutableSet re-check): a 'pending' column only ever exists for a
// plugin buildColumns (recordUtils.ts) already found non-immutable, so the plugin here is always
// mutable.
function pendingFieldCell(
  rowKey: string,
  i: number,
  plugin: string,
  wirePath: string | null,
  field: FieldSpec,
  condition: ConditionDiff,
  groupFieldPath: string,
  onOpen: (fk: string) => void,
  ctx: SectionCtx,
): React.ReactNode {
  const change = wirePath && ctx.pendingChangeMap ? ctx.pendingChangeMap[`${plugin}:${wirePath}`] : undefined;
  const base = condition.perPlugin[plugin];
  const editable = change && wirePath && field.renderEdit && base && ctx.onEdit && ctx.client;
  const onEdit = ctx.onEdit;
  const client = ctx.client;
  return (
    <td
      key={`${rowKey}:p${i}`}
      style={{
        ...baseCell,
        fontStyle: 'italic',
        backgroundColor: change ? 'rgba(255,200,50,0.10)' : undefined,
        opacity: change ? 1 : 0.3,
      }}
      onContextMenu={change && ctx.onPendingContextMenu
        ? e => { e.preventDefault(); ctx.onPendingContextMenu!(change.id, e.clientX, e.clientY); }
        : undefined}
    >
      {change && (editable
        ? field.renderEdit(
            overlayPendingEdits(base, condition.index, groupFieldPath, plugin, ctx.pendingChangeMap),
            { client, onOpen, onCommit: v => onEdit(plugin, wirePath, v) },
          )
        : <span>{pendingValueText(change.newValue)}</span>)}
    </td>
  );
}

function fieldCell(
  field: FieldSpec,
  condition: ConditionDiff,
  plugin: string,
  wirePath: string | null,
  onOpen: (fk: string) => void,
  ctx: SectionCtx,
): React.ReactNode {
  const c = condition.perPlugin[plugin];
  if (!c) return dash();
  if (field.renderEdit && wirePath && ctx.isEditable(plugin) && ctx.onEdit && ctx.client) {
    const onEdit = ctx.onEdit;
    const client = ctx.client;
    return field.renderEdit(c, { client, onOpen, onCommit: v => onEdit(plugin, wirePath, v) });
  }
  return field.render(c, onOpen);
}

// Move-up/move-down/remove controls for one condition row, per plugin column — mirrors VMAD's
// ArrayElementCell reorder buttons and RemoveScriptButton placement. Computes the plugin's current
// effective list (committed + its own outstanding per-field pending edits, #153 Q3) and stages the
// whole restaged list at the group's field path via the ordinary onEdit path (ADR-0019 — no
// separate structural-op wire dispatch; ADR-0032's whole-subtree-restage precedent).
function conditionRowControls(
  condition: ConditionDiff,
  groupConditions: ConditionDiff[],
  groupFieldPath: string,
  plugin: string,
  ctx: SectionCtx,
): React.ReactNode {
  if (!ctx.onEdit) return null;
  const onEdit = ctx.onEdit;
  const restage = (op: Parameters<typeof applyConditionListOp>[1]) => {
    const list = currentConditionList(groupConditions, groupFieldPath, plugin, ctx.pendingChangeMap);
    onEdit(plugin, groupFieldPath, applyConditionListOp(list, op));
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 6 }}>
      <button
        title="Move condition up"
        onClick={() => restage({ op: 'move_condition', index: condition.index, direction: 'up' })}
        style={iconBtnStyle}
      >▲</button>
      <button
        title="Move condition down"
        onClick={() => restage({ op: 'move_condition', index: condition.index, direction: 'down' })}
        style={iconBtnStyle}
      >▼</button>
      <button
        title="Remove condition"
        onClick={() => restage({ op: 'remove_condition', index: condition.index })}
        style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
      >×</button>
    </span>
  );
}

// The summary row plus, when expanded, one two-axis-colored row per field.
function conditionRows(
  condition: ConditionDiff,
  groupConditions: ConditionDiff[],
  key: string,
  groupFieldPath: string,
  isExpanded: boolean,
  ctx: SectionCtx,
): React.ReactNode[] {
  const { columns, onOpen, toggle } = ctx;
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
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            {c ? <span>{conditionSummary(c)}</span> : dash()}
            {ctx.isEditable(plugin) && conditionRowControls(condition, groupConditions, groupFieldPath, plugin, ctx)}
          </span>
        );
      })}
    </tr>,
  ];

  if (!isExpanded) return rows;

  for (const field of fieldsFor(condition)) {
    const fieldKey = `${key}>${field.label}`;
    // Absent key = that field is identical across plugins → no coloring (never fall back to the
    // whole-condition state, which would recolor every field when only one differs).
    const states = condition.fieldCellStates[field.key] ?? {};
    // #182: wirePath is now computed for a nested group too — wirePathFor/conditionFieldPath
    // already compose the enclosing array's index into the FieldPath segment correctly with no
    // change, since groupFieldPath is already the indexed string ("Effects[2].Conditions").
    const wirePath = wirePathFor(groupFieldPath, condition.index, field.key);
    rows.push(
      <tr key={fieldKey}>
        <td style={{ ...baseCell, paddingLeft: 28, opacity: 0.85 }}>{field.label}</td>
        {columns.map((col, i) => {
          if (col.kind === 'pending') return pendingFieldCell(fieldKey, i, col.plugin, wirePath, field, condition, groupFieldPath, onOpen, ctx);
          const plugin = col.override.plugin;
          return (
            <td key={`${fieldKey}:d${i}`} style={{ ...baseCell, ...getCellStyle(states[plugin]) }}>
              {fieldCell(field, condition, plugin, wirePath, onOpen, ctx)}
            </td>
          );
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
  // Mirrors VmadSectionProps: required, not optional — fail-closed. An empty set is the caller
  // explicitly saying "every column is editable".
  immutableSet: Set<string>;
  onEdit?: (plugin: string, path: string, value: unknown) => void;
  client?: RecordSessionClient;
  pendingChangeMap?: Record<string, PendingChange>;
  onPendingContextMenu?: (changeId: string, x: number, y: number) => void;
}

// A group's field path is indexed (composes an enclosing array's index, e.g. "Effects[2].
// Conditions") exactly when it's nested one array level below the record (#181) — the same
// shape-based signal the backend used to discover it, never a per-type name check.
function isNestedGroupPath(fieldPath: string): boolean {
  return fieldPath.includes('[');
}

export function ConditionSection({
  conditions, columns, onOpen, immutableSet, onEdit, client,
  pendingChangeMap, onPendingContextMenu,
}: Readonly<ConditionSectionProps>): React.ReactElement | null {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-group collapse (#181): a nested group defaults to collapsed (only its header shows until
  // toggled), while a flat top-level group is never collapsed — unaffected, same as before this
  // existed. Only overridden entries (the groups a user has actually clicked) are stored, so a
  // group that appears later still gets the right default without needing to be seeded up front.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const groups = conditions?.groups ?? [];
  if (groups.length === 0) return null;

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const isGroupCollapsed = (fieldPath: string): boolean =>
    collapsedOverrides[fieldPath] ?? isNestedGroupPath(fieldPath);

  const toggleGroup = (fieldPath: string) => setCollapsedOverrides(prev => ({
    ...prev,
    [fieldPath]: !(prev[fieldPath] ?? isNestedGroupPath(fieldPath)),
  }));

  const ctx: SectionCtx = {
    columns, onOpen, toggle,
    isEditable: plugin => !immutableSet.has(plugin),
    onEdit, client, pendingChangeMap, onPendingContextMenu,
  };

  // #154: a record can have more than one condition-carrying field (e.g. a Quest's
  // DialogConditions and UnusedConditions) — each group gets its own labeled header naming its
  // owning field, so a multi-list record renders as clearly separated sections rather than one
  // unlabeled merge. A single-group record (the common case, e.g. COBJ's "Conditions") renders
  // exactly as before, since the header text is just that one group's own field name.
  const rows: React.ReactNode[] = [];

  for (const group of groups) {
    const nested = isNestedGroupPath(group.fieldPath);
    const collapsed = nested && isGroupCollapsed(group.fieldPath);
    rows.push(
      <tr key={`${group.fieldPath}-header`}>
        <td colSpan={columns.length + 1} style={headerCell}>
          {nested && (
            <button style={toggleBtnStyle} onClick={() => toggleGroup(group.fieldPath)}>
              {collapsed ? '▶' : '▼'}
            </button>
          )}
          {group.fieldPath}
        </td>
      </tr>,
    );
    if (collapsed) continue;
    for (const condition of group.conditions) {
      const key = `${group.fieldPath}#${condition.index}`;
      rows.push(...conditionRows(condition, group.conditions, key, group.fieldPath, expanded.has(key), ctx));
    }
    // #183: the add-condition row now renders for a nested group too — the write path (whole-list
    // restage at the group's own composed field path) is live for both flat and nested groups.
    rows.push(addConditionRow(group.fieldPath, group.conditions, ctx));
  }

  return <>{rows}</>;
}

// One "＋ condition" row per condition list, mirroring VmadSection's "＋ script" row: a per-editable-
// plugin-column button that appends a default-valued condition and restages the whole list.
function addConditionRow(groupFieldPath: string, groupConditions: ConditionDiff[], ctx: SectionCtx): React.ReactNode {
  return (
    <tr key={`${groupFieldPath}:add`}>
      <td style={{ ...baseCell, opacity: 0.85 }}>＋ condition</td>
      {ctx.columns.map((col, i) => {
        if (col.kind === 'pending' || !ctx.isEditable(col.override.plugin) || !ctx.onEdit) {
          return <td key={`${groupFieldPath}:add:${i}`} style={baseCell} />;
        }
        const plugin = col.override.plugin;
        const onEdit = ctx.onEdit;
        return (
          <td key={`${groupFieldPath}:add:d${i}`} style={baseCell}>
            <button
              title="Add condition"
              onClick={() => {
                const list = currentConditionList(groupConditions, groupFieldPath, plugin, ctx.pendingChangeMap);
                onEdit(plugin, groupFieldPath, applyConditionListOp(list, { op: 'add_condition' }));
              }}
              style={{ ...iconBtnStyle, fontSize: '14px', padding: '0 4px' }}
            >+</button>
          </td>
        );
      })}
    </tr>
  );
}
