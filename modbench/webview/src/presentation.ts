import { displayValue, toBigInt } from './modelValue';
import { toStr } from './recordUtils';
import type { FieldDiff, FieldMetadata, FormKeyResolution } from './types';

/**
 * The presentation table: how one array element of a given schema leaf reads when its row is
 * collapsed, keyed by the leaf's own type name. This is the one place in the webview where a
 * game's own reading conventions live — everything else here works off metadata alone, so a
 * game-shaped rule that is not an entry in this table is in the wrong file.
 *
 * A formatter is pure: the element's value, its schema, and the FormKey resolutions the diff
 * already carries. It renders no markup and reads no panel state.
 */

/** The member every abstract union carries its concrete leaf's own type name in
 *  (LoquiUnions.UnionTypeDiscriminator) — one name across every game and every union. */
const UNION_TYPE = 'concrete_type';

export interface SummaryRow {
  /** This element's own value, in one column. */
  value: Record<string, unknown>;
  /** This element's schema. */
  meta: FieldMetadata;
  /** The resolution of the FormKey at this member path, in this column, when it has one. */
  resolution: (path: readonly string[]) => FormKeyResolution | undefined;
  /** This element is the last of its own list in this column. */
  isLast: boolean;
}

type Summarizer = (row: SummaryRow) => string;

// ── Fallout 4 conditions ─────────────────────────────────────────────────────
//
// xEdit's own wbConditionToStr (TES5Edit Core/wbDefinitionsCommon.pas), which is what a condition
// reads as everywhere modders already read one: the Run On prefix with its spaces stripped, or the
// reference in parentheses under Run On = Reference; the function and the parameter slots it
// actually uses; the comparison operator; the comparison value; and the conjunction that joins this
// condition to the next, absent on the list's last element.

const COMPARISON_OPERATORS: Record<string, string> = {
  EqualTo: '=', NotEqualTo: '<>', GreaterThan: '>', GreaterThanOrEqualTo: '>=',
  LessThan: '<', LessThanOrEqualTo: '<=',
};

/** The OR flag's own bit, from the schema's own member rather than a transcribed 1. */
const OR_FLAG = 'OR';

/** What xEdit shows for a reference: its EditorID alone, falling back to the raw FormKey — the
 *  short form of the "EditorID [FormKey]" a cell of its own shows (FormKeyLink.formKeyLabel). */
function shortName(value: unknown, resolution?: FormKeyResolution): string {
  return resolution?.editorId ?? toStr(value);
}

function memberMeta(meta: FieldMetadata | undefined, path: readonly string[]): FieldMetadata | undefined {
  let cur = meta;
  for (const name of path) cur = cur?.fields?.find(f => f.name === name);
  return cur;
}

/** A member's own label, as its cell would read it out. */
function memberLabel(row: SummaryRow, path: readonly string[], value: unknown): string {
  const meta = memberMeta(row.meta, path);
  return meta ? displayValue(value, meta) : toStr(value);
}

function conditionSummary(row: SummaryRow, comparison: (row: SummaryRow) => string): string {
  const data = (row.value.data ?? {}) as Record<string, unknown>;
  const operator = COMPARISON_OPERATORS[String(row.value.compare_operator)];
  return [
    runOn(row, data),
    '.',
    functionName(row, data),
    parameters(row, data),
    operator ? ` ${operator} ${comparison(row)}` : comparison(row),
    conjunction(row),
  ].join('');
}

function runOn(row: SummaryRow, data: Record<string, unknown>): string {
  if (data.run_on_type === 'Reference') {
    return `(${shortName(data.reference, row.resolution(['data', 'reference']))})`;
  }
  return memberLabel(row, ['data', 'run_on_type'], data.run_on_type).replace(/ /g, '');
}

/** The function member's own value, or — on the leaf that has no function member because it *is*
 *  one function (GetEventData) — that leaf's own type name, which is the function's name. */
function functionName(row: SummaryRow, data: Record<string, unknown>): string {
  return data.function != null
    ? memberLabel(row, ['data', 'function'], data.function)
    : toStr(data[UNION_TYPE]);
}

/** The slots this function uses, from the function member's own siblingsInUse. A slot Mutagen
 *  carries as a string is written to its own subrecord and reads on its own row, so xEdit leaves it
 *  out of the call — and a call whose first slot is left out has no parentheses at all. */
function parameters(row: SummaryRow, data: Record<string, unknown>): string {
  const slots = memberMeta(row.meta, ['data', 'function'])?.siblingsInUse?.[String(data.function)] ?? [];
  const written = (prefix: string): string | undefined => {
    const slot = slots.find(s => s.startsWith(prefix));
    if (slot == null || slot.endsWith('_string')) return undefined;
    return slot.endsWith('_record')
      ? shortName(data[slot], row.resolution(['data', slot]))
      : memberLabel(row, ['data', slot], data[slot]);
  };
  const first = written('parameter_one_');
  if (first == null) return '';
  const second = written('parameter_two_');
  return `(${second == null ? first : `${first}, ${second}`})`;
}

/** How this condition joins the next one. The last of a list joins nothing. */
function conjunction(row: SummaryRow): string {
  if (row.isLast) return '';
  const flags = memberMeta(row.meta, ['flags']);
  const orBit = flags?.enumMembers.find(m => m.value === OR_FLAG)?.bitValue;
  const isOr = orBit != null && (toBigInt(row.value.flags) & BigInt(orBit)) !== 0n;
  return isOr ? ' OR' : ' AND';
}

const floatComparison = (row: SummaryRow): string =>
  Number(row.value.comparison_value_float ?? 0).toFixed(6);

const globalComparison = (row: SummaryRow): string =>
  shortName(row.value.comparison_value_form_key, row.resolution(['comparison_value_form_key']));

const PRESENTATION_TABLE: Record<string, Summarizer> = {
  ConditionFloat: row => conditionSummary(row, floatComparison),
  ConditionGlobal: row => conditionSummary(row, globalComparison),
};

// ── The lookup the grid uses ─────────────────────────────────────────────────

/** The resolution the diff already carries for a member of this element, by member path. */
function resolutionAt(diff: FieldDiff, path: readonly string[], column: string): FormKeyResolution | undefined {
  let cur: FieldDiff | undefined = diff;
  for (const name of path) cur = cur?.children?.find(c => c.fieldName === name) ?? undefined;
  return cur?.resolutions?.[column];
}

/**
 * What each column's cell reads on this row while it is collapsed, or undefined when this row's
 * leaf has no entry in the table and the grid's own "{…}" stands.
 */
export function collapsedSummaries(
  diff: FieldDiff, meta: FieldMetadata, isLast: (column: string) => boolean,
): Record<string, string> | undefined {
  let summaries: Record<string, string> | undefined;
  for (const [column, value] of Object.entries(diff.values)) {
    if (value == null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const summarize = PRESENTATION_TABLE[String(row[UNION_TYPE])];
    if (!summarize) continue;
    summaries ??= {};
    summaries[column] = summarize({
      value: row,
      meta,
      resolution: path => resolutionAt(diff, path, column),
      isLast: isLast(column),
    });
  }
  return summaries;
}
