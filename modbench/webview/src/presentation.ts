import { displayValue, flagBits, toBigInt } from './modelValue';
import { getAtPath, metaAtPath, toStr } from './recordUtils';
import { siblingsInUseFor } from './siblingsInUse';
import type { FieldDiff, FieldMetadata, PathSegment } from './types';

// The one place in the webview where a game's own reading conventions live — a game-shaped rule
// that is not an entry in this table is in the wrong file.

// A formatter is pure: it renders no markup, reads no panel state, and changes neither the value
// the row commits nor the value it copies.

/** One member of the element being summarized, addressed by its path from the element's own root.
 *  Value, schema and resolution are joined here, so a formatter names each member once. */
export interface Member {
  value: unknown;
  /** The member's schema, for a rule that reads metadata rather than a value. */
  meta?: FieldMetadata;
  /** What this member's own cell reads out: an enum's label, a number, a plain string, a FormKey's
   *  "EditorID [FormKey]". */
  label: string;
  /** A FormKey member's EditorID alone, where `label` is the whole "EditorID [FormKey]". */
  shortName: string;
}

export interface SummaryRow {
  member: (...path: string[]) => Member;
  /** How the elements of an array member each read, in this column's own order. xEdit's summary
   *  passthrough: a container reads as its children do. */
  elements: (...path: string[]) => string[];
  /** The leaf this element turned out to be — the value of its schema's discriminator, or the type
   *  name its schema declares. */
  leaf: string;
  /** The schema's own word for that leaf, from the discriminator's label. Absent where the schema
   *  declares no discriminator — a value standing on its own, not a union's member. */
  kind?: string;
  /** This element is the last of its own list in this column. */
  isLast: boolean;
}

type Summarizer = (row: SummaryRow) => string;

// ── Fallout 4 conditions ─────────────────────────────────────────────────────
//
// xEdit's own wbConditionToStr (TES5Edit Core/wbDefinitionsCommon.pas) — the reading a condition
// already has everywhere it is read today.

const COMPARISON_OPERATORS: Record<string, string | undefined> = {
  EqualTo: '=', NotEqualTo: '<>', GreaterThan: '>', GreaterThanOrEqualTo: '>=',
  LessThan: '<', LessThanOrEqualTo: '<=',
};

// The OR flag's own member name; its bit is read off the schema, never transcribed.
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

// The function member's own value, or — on the leaf that declares no function member because it
// *is* one function (Fallout 4's GetEventData) — that leaf's own type name, which is the
// function's name.
function functionName(row: SummaryRow): string {
  const fn = row.member('data', 'function');
  const data = row.member('data');
  return fn.value != null ? fn.label : leafOf(data.meta, data.value) ?? '';
}

// A slot Mutagen carries as a string is written to its own subrecord and reads on its own row, so
// xEdit leaves it out of the call — and a call whose first slot is left out has no parentheses.
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

// The last condition of a list joins nothing.
function conjunction(row: SummaryRow): string {
  if (row.isLast) return '';
  const flags = row.member('flags');
  const orBit = flags.meta ? flagBits(flags.meta)?.find(b => b.value === OR_FLAG)?.bit : undefined;
  return orBit != null && (toBigInt(flags.value) & orBit) !== 0n ? ' OR' : ' AND';
}

const floatComparison = (row: SummaryRow): string =>
  Number(row.member('comparison_value_float').value ?? 0).toFixed(6);

const globalComparison = (row: SummaryRow): string => row.member('comparison_value_form_key').shortName;

// ── Fallout 4 scripts ────────────────────────────────────────────────────────
//
// xEdit's own wbScriptEntry / wbScriptProperty / wbScriptPropertyObject summaries
// (wbDefinitionsFO4.pas). Each is a `wbStructSK` whose sort-key member leads the summary unless the
// definition sets `dfSummaryNoSortKey`.

// The two alias slots that name something rather than an entry in a quest's alias list
// (wbAliasToStr, wbDefinitionsCommon.pas).
const RESERVED_ALIASES: Record<string, string | undefined> = { '-1': 'None', '-2': 'Player' };

// xEdit resolves an alias number past the two reserved ones through the owning quest's alias list;
// the compare wire carries no alias list, so the number stands for itself — what xEdit prints with
// `wbResolveAlias` off.
function scriptObject(row: SummaryRow): string {
  const alias = row.member('alias').label;
  return `${row.member('object').label}, Alias[${RESERVED_ALIASES[alias] ?? alias}]`;
}

// A leaf whose value is a list or a nested struct is absent: xEdit passes a property's value
// through only one level deep (`SetSummaryPassthroughMaxDepth(1)`), so such a property reads by
// name and kind alone.
const PROPERTY_VALUE_MEMBERS: Record<string, string | undefined> = {
  ScriptBoolProperty: 'data_bool',
  ScriptFloatProperty: 'data_float',
  ScriptIntProperty: 'data_int',
  ScriptStringProperty: 'data_string',
};

// Read anywhere but as a member of the script-property union, a value is just itself — which is
// how one class serves both as a property and as an element of a list of bindings.
function asProperty(row: SummaryRow, value: string | undefined): string {
  if (row.kind == null) return value ?? '';
  return `${row.member('name').label}: ${row.kind}${value == null ? '' : ` = ${value}`}`;
}

function scriptPropertyValue(row: SummaryRow): string | undefined {
  const member = PROPERTY_VALUE_MEMBERS[row.leaf];
  return member == null ? undefined : row.member(member).label;
}

// xEdit passes the properties list through rather than counting it. Its length caps
// (`SetSummaryPassthroughMaxLength`) answer a fixed-width tree column; this cell ellipsizes at its
// own width, so the summary carries every property.
function scriptEntry(row: SummaryRow): string {
  return `${row.member('name').label}(${row.elements('properties').join(', ')})`;
}

const PRESENTATION_TABLE: Record<string, Summarizer | undefined> = {
  ConditionFloat: row => conditionSummary(row, floatComparison),
  ConditionGlobal: row => conditionSummary(row, globalComparison),
  ScriptEntry: scriptEntry,
  // Reached by every leaf of the script-property union that has no reading of its own.
  ScriptProperty: row => asProperty(row, scriptPropertyValue(row)),
  // The one class the schema reaches both ways: a leaf of that union, and the element type of a
  // list of bindings. `asProperty` is what tells the two apart.
  ScriptObjectProperty: row => asProperty(row, scriptObject(row)),
};

// ── The lookup the grid uses ─────────────────────────────────────────────────

const discriminatorOf = (meta: FieldMetadata | undefined): string | undefined =>
  meta?.fields?.find(f => f.isDiscriminator)?.name;

// The leaf a discriminator names is what the value turned out to be, where the declared type name
// says only what the schema promised — a union is exactly where the two disagree.
function leafOf(meta: FieldMetadata | undefined, value: unknown): string | null | undefined {
  const discriminator = discriminatorOf(meta);
  if (discriminator == null) return meta?.leafTypeName;
  const leaf = (value as Record<string, unknown> | null)?.[discriminator];
  // A union whose value names no leaf has none, not the declared base: a concrete base is one of
  // its own leaves, so falling back there would hand an object of unknown leaf the base's reading.
  return typeof leaf === 'string' ? leaf : undefined;
}

// A leaf the table has no entry of its own for reads by its declared base's entry, since a union's
// leaves mostly share one reading and differ only in which member holds the value.
function summarizerFor(
  meta: FieldMetadata | undefined, value: unknown,
): { summarize: Summarizer; leaf: string } | undefined {
  const leaf = leafOf(meta, value);
  if (leaf == null) return undefined;
  const summarize = PRESENTATION_TABLE[leaf]
    ?? (meta?.leafTypeName == null ? undefined : PRESENTATION_TABLE[meta.leafTypeName]);
  return summarize == null ? undefined : { summarize, leaf };
}

const COLLAPSED_PLACEHOLDER = '{…}';

const memberPath = (path: readonly string[]): PathSegment[] =>
  path.map(name => ({ kind: 'member', name }));

function diffAt(diff: FieldDiff, path: readonly string[]): FieldDiff | undefined {
  let cur: FieldDiff | undefined = diff;
  for (const name of path) cur = cur?.children?.find(c => c.fieldName === name) ?? undefined;
  return cur;
}

/** Empty for every row whose leaf has no entry in the table — which is where the grid's own "{…}"
 *  stands. */
export function collapsedSummaries(
  diff: FieldDiff, meta: FieldMetadata, isLast: (column: string) => boolean,
): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const column of Object.keys(diff.values)) {
    const summary = summaryIn(diff, meta, column, isLast(column));
    if (summary != null) summaries[column] = summary;
  }
  return summaries;
}

function summaryIn(
  diff: FieldDiff, meta: FieldMetadata | undefined, column: string, isLast: boolean,
): string | undefined {
  const value = diff.values[column];
  const found = summarizerFor(meta, value);
  if (!found) return undefined;

  const discriminator = discriminatorOf(meta);
  const member = (...path: string[]): Member => {
    const memberMeta = metaAtPath(meta, memberPath(path));
    const memberValue = getAtPath(value, memberPath(path));
    const resolution = diffAt(diff, path)?.resolutions?.[column];
    return {
      value: memberValue,
      meta: memberMeta,
      label: memberMeta ? displayValue(memberValue, memberMeta, resolution) : toStr(memberValue),
      shortName: resolution?.editorId ?? toStr(memberValue),
    };
  };

  return found.summarize({
    isLast,
    member,
    leaf: found.leaf,
    kind: discriminator == null ? undefined : member(discriminator).label,
    elements: (...path) => {
      const listMeta = metaAtPath(meta, memberPath(path))?.elementType ?? undefined;
      const present = (diffAt(diff, path)?.children ?? []).filter(c => c.values[column] != null);
      return present.map((child, i) =>
        summaryIn(child, listMeta, column, i === present.length - 1) ?? COLLAPSED_PLACEHOLDER);
    },
  });
}
