import { displayValue, flagBits, toBigInt } from './modelValue';
import { getAtPath, metaAtPath, toStr } from './recordUtils';
import { siblingsInUseFor } from './siblingsInUse';
import type { FieldDiff, FieldMetadata, FormKeyResolution, PathSegment } from './types';

/**
 * The presentation table: how one array element of a given schema leaf reads when its row is
 * collapsed, keyed by that leaf's own type name. This is the one place in the webview where a
 * game's own reading conventions live — everything else here works off metadata alone, so a
 * game-shaped rule that is not an entry in this table is in the wrong file.
 *
 * A formatter is pure: it addresses this element's members, and nothing else. It renders no markup,
 * reads no panel state, and changes neither the value the row commits nor the value it copies.
 */

/** One member of the element being summarized, addressed by its path from the element's own root.
 *  The three trees a row is spread across — its value, its schema, and the resolutions on its diff
 *  — are joined here, so a formatter names each member once instead of walking three of them. */
export interface Member {
  value: unknown;
  /** The member's schema, for a rule that reads metadata rather than a value. */
  meta?: FieldMetadata;
  /** What this member's own cell reads out: an enum's label, a number, a plain string. */
  label: string;
  /** A FormKey member's EditorID, falling back to the bare FormKey — the short form of the
   *  "EditorID [FormKey]" its own cell shows (FormKeyLink.formKeyLabel). */
  shortName: string;
}

export interface SummaryRow {
  member: (...path: string[]) => Member;
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

/** The OR flag's own member name; its bit is read off the schema, never transcribed. */
const OR_FLAG = 'OR';

function conditionSummary(row: SummaryRow, comparison: (row: SummaryRow) => string): string {
  // An operator outside the schema's own six reads as no operator at all, exactly as xEdit's own
  // `case Typ and $E0` falls through — the condition still reads, missing only the sign.
  const operator = COMPARISON_OPERATORS[String(row.member('compare_operator').value)];
  const call = `${runOn(row)}.${functionName(row)}${parameters(row)}`;
  return `${call}${operator ? ` ${operator} ` : ''}${comparison(row)}${conjunction(row)}`;
}

function runOn(row: SummaryRow): string {
  const runOnType = row.member('data', 'run_on_type');
  if (runOnType.value === 'Reference') return `(${row.member('data', 'reference').shortName})`;
  return runOnType.label.replace(/ /g, '');
}

/** The function member's own value, or — on the leaf that declares no function member because it
 *  *is* one function (Fallout 4's GetEventData) — that leaf's own type name, which is the
 *  function's name. */
function functionName(row: SummaryRow): string {
  const fn = row.member('data', 'function');
  const data = row.member('data');
  return fn.value != null ? fn.label : leafOf(data.meta, data.value) ?? '';
}

/** The slots this function uses, from the function member's own siblingsInUse. A slot Mutagen
 *  carries as a string is written to its own subrecord and reads on its own row, so xEdit leaves it
 *  out of the call — and a call whose first slot is left out has no parentheses at all. */
function parameters(row: SummaryRow): string {
  const fn = row.member('data', 'function');
  const slots = fn.meta ? siblingsInUseFor(fn.meta, fn.value) : [];
  const written = (prefix: string): string | undefined => {
    const slot = slots.find(s => s.startsWith(prefix));
    if (slot == null || slot.endsWith('_string')) return undefined;
    const member = row.member('data', slot);
    return slot.endsWith('_record') ? member.shortName : member.label;
  };
  const first = written('parameter_one_');
  if (first == null) return '';
  const second = written('parameter_two_');
  return `(${second == null ? first : `${first}, ${second}`})`;
}

/** How this condition joins the next one. The last of a list joins nothing. */
function conjunction(row: SummaryRow): string {
  if (row.isLast) return '';
  const flags = row.member('flags');
  const orBit = flags.meta ? flagBits(flags.meta)?.find(b => b.value === OR_FLAG)?.bit : undefined;
  return orBit != null && (toBigInt(flags.value) & orBit) !== 0n ? ' OR' : ' AND';
}

const floatComparison = (row: SummaryRow): string =>
  Number(row.member('comparison_value_float').value ?? 0).toFixed(6);

const globalComparison = (row: SummaryRow): string => row.member('comparison_value_form_key').shortName;

const PRESENTATION_TABLE: Record<string, Summarizer> = {
  ConditionFloat: row => conditionSummary(row, floatComparison),
  ConditionGlobal: row => conditionSummary(row, globalComparison),
};

// ── The lookup the grid uses ─────────────────────────────────────────────────

/** The concrete leaf an object is, read off whichever member the schema itself marks as the
 *  discriminator — `concrete_type` for a Loqui union, `value_type` for OMOD's, never a name
 *  written here. Undefined for an element that is not a union at all, which has no entry. */
function leafOf(meta: FieldMetadata | undefined, value: unknown): string | undefined {
  const discriminator = meta?.fields?.find(f => f.isDiscriminator)?.name;
  const leaf = discriminator == null ? undefined : (value as Record<string, unknown> | null)?.[discriminator];
  // Always a string on the wire (the discriminator is an enum of leaf type names); anything else
  // is a shape this table has no entry for either way.
  return typeof leaf === 'string' ? leaf : undefined;
}

const memberPath = (path: readonly string[]): PathSegment[] =>
  path.map(name => ({ kind: 'member', name }));

/** The resolution the diff already carries for a member of this element, by member path. */
function resolutionAt(diff: FieldDiff, path: readonly string[], column: string): FormKeyResolution | undefined {
  let cur: FieldDiff | undefined = diff;
  for (const name of path) cur = cur?.children?.find(c => c.fieldName === name) ?? undefined;
  return cur?.resolutions?.[column];
}

/**
 * What each column's cell reads on this row while it is collapsed. Empty for every row whose leaf
 * has no entry in the table — which is where the grid's own "{…}" stands.
 */
export function collapsedSummaries(
  diff: FieldDiff, meta: FieldMetadata, isLast: (column: string) => boolean,
): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const [column, value] of Object.entries(diff.values)) {
    const leaf = leafOf(meta, value);
    const summarize = leaf == null ? undefined : PRESENTATION_TABLE[leaf];
    if (!summarize) continue;
    summaries[column] = summarize({
      isLast: isLast(column),
      member: (...path) => {
        const memberMeta = metaAtPath(meta, memberPath(path));
        const memberValue = getAtPath(value, memberPath(path));
        return {
          value: memberValue,
          meta: memberMeta,
          label: memberMeta ? displayValue(memberValue, memberMeta) : toStr(memberValue),
          shortName: resolutionAt(diff, path, column)?.editorId ?? toStr(memberValue),
        };
      },
    });
  }
  return summaries;
}
