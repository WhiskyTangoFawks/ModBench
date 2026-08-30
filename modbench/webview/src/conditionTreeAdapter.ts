// Issue #231: maps Conditions (CTDA) into the same node shape the compare grid's ordinary fields
// already use (FieldDiff + FieldMetadata), so ConditionSection's bespoke row/cell renderers can
// be deleted and condition rows become ordinary rows in the one tree.
//
// Shape: one top-level synthesized FieldDiff per condition-owning field (`ConditionGroupDiff`) —
// a genuine `type: 'array'` row, not a struct-like container the way a VMAD script is. A
// condition list's add/remove/move already restages the whole list at one field path (the
// deleted ConditionSection's own `conditionRowControls`/`addConditionRow`, `conditionOps.ts`), the
// same shape an ordinary unsorted array already restages in — so representing it as one lets the
// *existing* array-op machinery (right-click Add/Remove/Move Up/Move Down, Insert/Delete/Ctrl+↑/↓)
// apply with zero new commands, exactly the ticket's "consistent with array operations" AC.
//
// Each condition is an array element (a struct: its typed fields as members, exactly like an
// ordinary struct). Its *collapsed* label is the one deliberate exception to "a struct shows
// {…}": DiffRow.tsx renders `diff.collapsedSummary[plugin]` in place of the generic placeholder
// when present — an xEdit-style one-line prose summary (`wbConditionToStr`,
// references/TES5Edit/Core/wbDefinitionsCommon.pas), matching what a modder already recognizes
// from xEdit itself rather than the generic JSON/`{…}` every other struct row is content with
// (ADR-0034). Unlike an ordinary struct member, each condition field carries its own `wirePath`
// (`CTDA\FieldPath\Index\SubField`, conditionPath.ts) — a field commits independently (no stable
// per-element identity to restage atomically the way VMAD's structs do), which is exactly what a
// `wirePath`-bearing child triggers in RecordPanel's row-builder (subtreeFor).
//
// Three fields are composite (their own widget depends on their own per-plugin value's shape, the
// same pattern #229's VmadObjectEditor established): Function opens a QuickPick, never a text
// editor; Run On is a target enum plus a conditional FormKey; Comparison and a parameter each pick
// FormKey vs plain scalar from their own current value. The AND/OR gate is `readOnly` — it was
// never editable under the pre-#231 model either.
import type { FieldDiff, FieldMetadata, ConditionCompare, ConditionDiff, ConditionGroupDiff, ParsedCondition } from './types';
import { conditionFieldPath, conditionParamPath } from './conditionPath';
import { defaultCondition } from './conditionOps';
import { sparseArrayByPlugin, aggregateConflictAll } from './recordUtils';

const OPERATOR_VALUES = ['EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo'];

// xEdit's own comparison symbols (wbConditionToStr's `case Typ and $E0 of` — $00/$20/$40/$60/$80/
// $A0), reused verbatim so the collapsed summary reads exactly as it would in xEdit itself.
const OP_SYMBOL: Record<ParsedCondition['operator'], string> = {
  EqualTo: '=', NotEqualTo: '<>', GreaterThan: '>', GreaterThanOrEqualTo: '>=', LessThan: '<', LessThanOrEqualTo: '<=',
};

// A condition parameter's own display text within the summary's `(param1, param2)` — Form/Text/
// Number pick their own representation from the parameter's own category, same discrimination
// ConditionParamCell already makes for its own widget. A Form parameter shows its raw FormKey
// (never an EditorID): conditionTreeAdapter never receives FormKey resolutions for a condition's
// own parameters (unlike a top-level formKey leaf's `resolutions`, ADR-0031) — a raw FormKey here
// is the same "unresolved, not wrong" state ConditionParamCell's own FormKeyCell shows today.
// Issue #165: a decoded Number parameter shows only its member name (e.g. "Male"), matching
// xEdit's own wbConditionToStr, which renders an enum-backed parameter's `.Summary` alone — never
// the raw value once a name is known.
function paramSummary(p: ParsedCondition['parameters'][number]): string {
  if (p.category === 'Form') return p.formKey ?? 'NULL';
  if (p.category === 'Text') return p.text ?? '';
  return p.decodedValue ?? String(p.number ?? 0);
}

// Issue #231 (review, design call): the exact shape of xEdit's `wbConditionToStr`
// (references/TES5Edit/Core/wbDefinitionsCommon.pas) — "RunOn.Function(param1, param2) Op
// Comparison[ AND/OR]", the trailing conjunction omitted only for the last condition *this
// plugin itself* has in the list (xEdit's own `Container.Equals(Conditions.Elements[Pred(l)])`
// check, generalized here to "this plugin's own last non-null row" since plugins can disagree on
// how many conditions a list has, ADR-0016/#178's per-plugin sparse alignment).
function formatConditionSummary(c: ParsedCondition, isLastForPlugin: boolean): string {
  const runOn = c.runOnTarget === 'Reference' ? `(${c.runOnReference ?? 'NULL'})` : c.runOnTarget;
  const call = c.parameters.length > 0 ? `${c.function}(${c.parameters.map(paramSummary).join(', ')})` : c.function;
  const comparison = c.useGlobal ? (c.comparisonGlobal ?? 'NULL') : String(c.comparisonFloat ?? 0);
  let suffix = '';
  if (!isLastForPlugin) suffix = c.or ? ' OR' : ' AND';
  return `${runOn}.${call} ${OP_SYMBOL[c.operator]} ${comparison}${suffix}`;
}

// This plugin's own last non-null condition index in the group — conditions are listed in
// ascending index order (ADR-0016), so the last write for a plugin as we scan is its own highest.
function lastIndexByPlugin(conditions: ConditionDiff[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const condition of conditions) {
    for (const plugin of Object.keys(condition.perPlugin)) {
      if (condition.perPlugin[plugin] != null) result[plugin] = condition.index;
    }
  }
  return result;
}

function scalarMeta(type: 'string' | 'int' | 'float' | 'bool'): FieldMetadata {
  return { name: '', type, isArray: false, validFormKeyTypes: [], enumValues: [] };
}
// One shape for any leaf whose enumValues carries its options — 'enum' (Operator, a plain
// hand-listed set) and 'conditionRunOn' (Run On, #167: enumValues is the server's Run On target
// catalog, GET /condition-run-on-targets, threaded in from buildConditionRows rather than a
// hardcoded FO4 member list) differ only in which widget DiffRow dispatches to, not in shape.
function enumTypedMeta(type: 'enum' | 'conditionRunOn', values: string[]): FieldMetadata {
  return { name: '', type, isArray: false, validFormKeyTypes: [], enumValues: values };
}
const FUNCTION_META: FieldMetadata = { name: '', type: 'conditionFunction', isArray: false, validFormKeyTypes: [], enumValues: [] };
const COMPARISON_META: FieldMetadata = { name: '', type: 'conditionComparison', isArray: false, validFormKeyTypes: [], enumValues: [] };
const PARAM_META: FieldMetadata = { name: '', type: 'conditionParam', isArray: false, validFormKeyTypes: [], enumValues: [] };
const GATE_META: FieldMetadata = { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [], readOnly: true };

// Per-plugin values for one condition field, skipping a plugin this condition is absent from
// (matching FieldDiff's own "absent field renders as an empty cell" convention).
function fieldValues<T>(perPlugin: Record<string, ParsedCondition | null>, extract: (c: ParsedCondition) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [plugin, c] of Object.entries(perPlugin)) if (c) out[plugin] = extract(c);
  return out;
}

interface FieldSpec { name: string; key: string; meta: FieldMetadata; wire: string | null; values: Record<string, unknown> }

function envelopeFields(condition: ConditionDiff, groupFieldPath: string, runOnTargets: string[]): FieldSpec[] {
  const idx = condition.index;
  const wire = (subField: string) => conditionFieldPath(groupFieldPath, idx, subField);
  return [
    { name: 'Function', key: 'function', meta: FUNCTION_META, wire: wire('Function'), values: fieldValues(condition.perPlugin, c => c.function) },
    { name: 'Run On', key: 'runOn', meta: enumTypedMeta('conditionRunOn', runOnTargets), wire: wire('RunOn'), values: fieldValues(condition.perPlugin, c => ({ target: c.runOnTarget, reference: c.runOnReference ?? null })) },
    { name: 'Operator', key: 'operator', meta: enumTypedMeta('enum', OPERATOR_VALUES), wire: wire('Operator'), values: fieldValues(condition.perPlugin, c => c.operator) },
    { name: 'Use Global', key: 'useGlobal', meta: scalarMeta('bool'), wire: wire('UseGlobal'), values: fieldValues(condition.perPlugin, c => c.useGlobal) },
    // A bare scalar, matching the existing wire format exactly (no backend change): the composite
    // cell (slice 4) infers FormKey-vs-float from the value's own JS type, not a sibling flag.
    { name: 'Comparison', key: 'comparison', meta: COMPARISON_META, wire: wire('Comparison'), values: fieldValues(condition.perPlugin, c => (c.useGlobal ? (c.comparisonGlobal ?? null) : (c.comparisonFloat ?? null))) },
    // No wirePath — the AND/OR gate has never been editable (readOnly, not merely unwired).
    { name: 'Type', key: 'gate', meta: GATE_META, wire: null, values: fieldValues(condition.perPlugin, c => (c.or ? 'OR' : 'AND')) },
  ];
}

function paramFields(condition: ConditionDiff, groupFieldPath: string): FieldSpec[] {
  const maxParams = Math.max(0, ...Object.values(condition.perPlugin).map(c => c?.parameters.length ?? 0));
  return Array.from({ length: maxParams }, (_, i) => ({
    name: `Parameter ${i + 1}`,
    key: `param:${i}`,
    meta: PARAM_META,
    wire: conditionParamPath(groupFieldPath, condition.index, i),
    values: fieldValues(condition.perPlugin, c => c.parameters[i] ?? null),
  }));
}

// Function, Parameters…, then the rest of the envelope — matching the deleted ConditionSection's
// own left-to-right summary order.
function fieldsFor(condition: ConditionDiff, groupFieldPath: string, runOnTargets: string[]): FieldSpec[] {
  const envelope = envelopeFields(condition, groupFieldPath, runOnTargets);
  return [envelope[0], ...paramFields(condition, groupFieldPath), ...envelope.slice(1)];
}

function buildCondition(
  condition: ConditionDiff, groupFieldPath: string, lastIndexForPlugin: Record<string, number>, runOnTargets: string[],
): { diff: FieldDiff; meta: FieldMetadata } {
  const specs = fieldsFor(condition, groupFieldPath, runOnTargets);
  const children: FieldDiff[] = specs.map(spec => {
    const cellStates = condition.fieldCellStates[spec.key] ?? {};
    return {
      fieldName: spec.name,
      values: spec.values,
      winnerColumn: condition.winnerColumn,
      winnerValue: spec.values[condition.winnerColumn] ?? null,
      cellStates,
      // Issue #114: a field leaf's own bottom-up conflictAll (no children of its own).
      conflictAll: aggregateConflictAll(cellStates),
      wirePath: spec.wire ?? undefined,
      // #166: ADR-0031 resolution for this field's own FormKey slot (runOn/comparison/param:{i}
      // only — undefined for function/operator/gate, which carry no FormKey), keyed by plugin same
      // as every other FieldDiff.resolutions — DiffRow's existing generic pass-through
      // (`diff.resolutions?.[plugin]`) reaches FormKeyCell inside the composite cells with no
      // DiffRow change needed.
      resolutions: condition.fieldResolutions?.[spec.key],
    };
  });
  const fields: FieldMetadata[] = specs.map(spec => ({ ...spec.meta, name: spec.name }));
  // The struct row's own "value" is never shown as JSON (collapsed rows show collapsedSummary
  // below instead), but Ctrl+C and drag on it still copy this — the whole condition, matching
  // every other compound field's "copy the real value, not the placeholder" rule (AC5/AC6
  // elsewhere in this grid; modelValue.ts's own struct branch is untouched by this design call).
  const wholeValues = fieldValues(condition.perPlugin, c => c);
  // Issue #231 (review, design call): per-plugin, not fieldValues' single-`winnerColumn` shortcut
  // above — whether *this plugin's own* condition list ends here differs per plugin whenever
  // plugins disagree on how many conditions the list has (the same case wholeValues' own sparse
  // alignment already handles).
  const collapsedSummary: Record<string, string> = {};
  for (const [plugin, c] of Object.entries(condition.perPlugin)) {
    if (c) collapsedSummary[plugin] = formatConditionSummary(c, condition.index === lastIndexForPlugin[plugin]);
  }
  return {
    diff: {
      fieldName: `[${condition.index}]`,
      values: wholeValues,
      winnerColumn: condition.winnerColumn,
      winnerValue: wholeValues[condition.winnerColumn] ?? null,
      cellStates: condition.cellStates,
      // Issue #114: this condition's own bottom-up conflictAll — its own whole-condition
      // cellStates folded with the worst of its own field children (Function/Parameters/Run
      // On/etc.), so a collapsed condition row still shows a tint when one of its fields differs
      // even if condition.cellStates itself didn't already capture it.
      conflictAll: aggregateConflictAll(condition.cellStates, children),
      children,
      collapsedSummary,
    },
    meta: { name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [], fields },
  };
}

function buildGroup(group: ConditionGroupDiff, runOnTargets: string[]): { diff: FieldDiff; meta: FieldMetadata } {
  const lastIndexForPlugin = lastIndexByPlugin(group.conditions);
  const conditionBuilds = group.conditions.map(c => buildCondition(c, group.fieldPath, lastIndexForPlugin, runOnTargets));
  const values = sparseArrayByPlugin(group.conditions.map(c => c.perPlugin));
  const winnerColumn = Object.keys(values)[0] ?? '';
  const elementMeta = conditionBuilds[0]?.meta
    ?? { name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [], fields: [] };
  const conditionDiffs = conditionBuilds.map(b => b.diff);
  return {
    diff: {
      fieldName: group.fieldPath,
      wirePath: group.fieldPath,
      values,
      winnerColumn,
      winnerValue: values[winnerColumn] ?? null,
      cellStates: {},
      // Issue #114: the group (array) row's own bottom-up conflictAll — it carries no cellStates
      // of its own, so this is purely the worst of its condition elements.
      conflictAll: aggregateConflictAll({}, conditionDiffs),
      children: conditionDiffs,
    },
    meta: {
      name: group.fieldPath, type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
      // Issue #231: a fresh condition's wire shape is `ParsedCondition`, not a generic
      // per-display-field-name struct default recordUtils.ts's own defaultElementValue would
      // otherwise build — defaultCondition() (conditionOps.ts) is the same "sensible defaults,
      // immediately editable" shape #153 always started a new condition with.
      elementType: { ...elementMeta, defaultValue: defaultCondition() },
    },
  };
}

export interface ConditionTreeRows {
  diffs: FieldDiff[];
  metaMap: Record<string, FieldMetadata>;
}

// The one exported entry point — RecordPanel merges `diffs` into its own `diffs` array and
// `metaMap` into its own `fieldMetaMap` (both additive; a condition-owning field is never also
// reflected as a generic field row — SchemaReflector already excludes it, #178).
//
// Issue #167: `runOnTargets` is the server's Run On target catalog (RecordPanel's own
// `client.conditionRunOnTargets()` fetch, GET /condition-run-on-targets) — defaulted to `[]` so
// every existing call site that doesn't yet have it in hand keeps compiling (the Run On cell
// simply has no options to show until the fetch resolves, the same transient-empty state any
// other once-per-load order catalog fetch has before it lands).
export function buildConditionRows(
  conditions: ConditionCompare | null | undefined, runOnTargets: string[] = [],
): ConditionTreeRows {
  const diffs: FieldDiff[] = [];
  const metaMap: Record<string, FieldMetadata> = {};
  for (const group of conditions?.groups ?? []) {
    const { diff, meta } = buildGroup(group, runOnTargets);
    diffs.push(diff);
    metaMap[group.fieldPath] = meta;
  }
  return { diffs, metaMap };
}
