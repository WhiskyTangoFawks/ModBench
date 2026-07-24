// Structural condition-list ops (#153): add/remove/reorder a plugin's condition list. Unlike
// vmadOps.ts's StructOp (a payload dispatched to the backend and applied op-aware), a condition
// list has no stable per-element identity to target (ADR-0019 — array indices have no stable
// identity), so arity/order changes are computed entirely client-side and staged as one plain
// FieldEdit value at the list's own field path — the same whole-subtree-restage pattern VMAD's
// plain arrays already use. There is no backend op dispatch to mirror here; this module's job is
// purely to compute the new list.
import type { ConditionDiff, ConditionOperator, ParsedCondition, ParsedConditionParam, PendingChange } from './types';
import { CONDITION_SUBFIELD_WIRE, conditionFieldPath, conditionParamPath } from './conditionPath';

export type ConditionListOp =
  | { op: 'add_condition' }
  | { op: 'remove_condition'; index: number }
  | { op: 'move_condition'; index: number; direction: 'up' | 'down' };

// Sensible defaults for a newly-added condition (#153 AC1: "appearing with sensible defaults and
// immediately editable"). GetIsID takes no parameters, so no parameter slots need populating.
export function defaultCondition(): ParsedCondition {
  return {
    function: 'GetIsID',
    operator: 'EqualTo',
    or: false,
    runOnTarget: 'Subject',
    runOnReference: null,
    useGlobal: false,
    comparisonFloat: 0,
    comparisonGlobal: null,
    parameters: [],
  };
}

// Applies one structural op to a plugin's current condition list, producing the new full list to
// stage via plain onEdit. Out-of-range indices are a no-op — defensive; callers only ever pass
// indices derived from currently-rendered rows.
export function applyConditionListOp(list: ParsedCondition[], op: ConditionListOp): ParsedCondition[] {
  if (op.op === 'add_condition') return [...list, defaultCondition()];

  if (op.op === 'remove_condition') {
    if (op.index < 0 || op.index >= list.length) return list;
    return list.filter((_, i) => i !== op.index);
  }

  const other = op.direction === 'up' ? op.index - 1 : op.index + 1;
  if (op.index < 0 || op.index >= list.length || other < 0 || other >= list.length) return list;
  const next = [...list];
  [next[op.index], next[other]] = [next[other], next[op.index]];
  return next;
}

function overlayField(condition: ParsedCondition, key: string, value: unknown): ParsedCondition {
  switch (key) {
    case 'function':
      return { ...condition, function: value as string };
    case 'operator':
      return { ...condition, operator: value as ConditionOperator };
    case 'useGlobal':
      return { ...condition, useGlobal: value as boolean };
    case 'runOn': {
      const v = value as { target: string; reference: string | null };
      return { ...condition, runOnTarget: v.target, runOnReference: v.reference };
    }
    case 'comparison':
      return condition.useGlobal
        ? { ...condition, comparisonGlobal: value as string }
        : { ...condition, comparisonFloat: value as number };
    default:
      return overlayParam(condition, key, value);
  }
}

function overlayParam(condition: ParsedCondition, key: string, value: unknown): ParsedCondition {
  const paramMatch = /^param:(\d+)$/.exec(key);
  if (!paramMatch) return condition;
  const index = Number(paramMatch[1]);
  const p = condition.parameters[index];
  if (!p) return condition;

  const nextParam: ParsedConditionParam = p.category === 'Form'
    ? { ...p, formKey: value as string }
    : p.category === 'Text'
      ? { ...p, text: value as string }
      : { ...p, number: value as number };

  const parameters = condition.parameters.slice();
  parameters[index] = nextParam;
  return { ...condition, parameters };
}

// Builds the base list an add/remove/move op applies against: `conditions` restricted to `plugin`
// (skipping rows that plugin doesn't have) in index order, each overlaid with any of that plugin's
// outstanding per-field pending edits from `pendingChangeMap` (the same source ConditionSection's
// pending column already reads, keyed `${plugin}:${wirePath}`). Without this fold, a subsequent
// add/remove/move would silently discard an unsaved field edit sitting on top of the committed data
// (#153 Q3).
export function currentConditionList(
  conditions: ConditionDiff[],
  fieldPath: string,
  plugin: string,
  pendingChangeMap?: Record<string, PendingChange>,
): ParsedCondition[] {
  const result: ParsedCondition[] = [];
  for (const condition of conditions) {
    const base = condition.perPlugin[plugin];
    if (!base) continue;
    result.push(overlayPendingEdits(base, condition.index, fieldPath, plugin, pendingChangeMap));
  }
  return result;
}

function overlayPendingEdits(
  base: ParsedCondition,
  index: number,
  fieldPath: string,
  plugin: string,
  pendingChangeMap?: Record<string, PendingChange>,
): ParsedCondition {
  if (!pendingChangeMap) return base;

  let overlaid = base;
  for (const key of Object.keys(CONDITION_SUBFIELD_WIRE)) {
    const wirePath = conditionFieldPath(fieldPath, index, CONDITION_SUBFIELD_WIRE[key]);
    const change = pendingChangeMap[`${plugin}:${wirePath}`];
    if (change) overlaid = overlayField(overlaid, key, change.newValue);
  }
  for (let i = 0; i < base.parameters.length; i++) {
    const wirePath = conditionParamPath(fieldPath, index, i);
    const change = pendingChangeMap[`${plugin}:${wirePath}`];
    if (change) overlaid = overlayField(overlaid, `param:${i}`, change.newValue);
  }
  return overlaid;
}
