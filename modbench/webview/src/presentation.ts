import { displayValue, flagBits, toBigInt } from './modelValue';
import { getAtPath, metaAtPath, toStr } from './recordUtils';
import { siblingsInUseFor } from './siblingsInUse';
import type { FieldDiff, FieldMetadata, PathSegment } from './types';

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
  /** What this member's own cell reads out: an enum's label, a number, a plain string, a FormKey's
   *  "EditorID [FormKey]". */
  label: string;
  /** A FormKey member's EditorID alone, where `label` is the whole "EditorID [FormKey]" its own
   *  cell shows (FormKeyLink.formKeyLabel). */
  shortName: string;
}

export interface SummaryRow {
  member: (...path: string[]) => Member;
  /** How the elements of an array member each read, in this column's own order — one entry per
   *  element this column holds. xEdit's summary passthrough: a container reads as its children do.
   *  An element whose own leaf has no reading contributes the same placeholder its own row shows. */
  elements: (...path: string[]) => string[];
  /** The leaf this element turned out to be — the value of its schema's discriminator, or the type
   *  name its schema declares. */
  leaf: string;
  /** The schema's own word for that leaf, from the discriminator member's own label. Absent where
   *  the element's schema declares no discriminator, which is where it is not a union's member at
   *  all but a value standing on its own. */
  kind?: string;
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

const COMPARISON_OPERATORS: Record<string, string | undefined> = {
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

// ── Fallout 4 scripts ────────────────────────────────────────────────────────
//
// xEdit's own wbScriptEntry / wbScriptProperty / wbScriptPropertyObject summaries
// (TES5Edit Core/wbDefinitionsFO4.pas:3823, :3883, :3948). Each of those is a `wbStructSK` whose
// sort-key member leads the summary unless the definition sets `dfSummaryNoSortKey` — which is why
// a script reads under its own name and an object binding, whose sort key is already in its summary
// key, does not.

/** The two alias slots that name something rather than an entry in a quest's alias list
 *  (wbAliasToStr, wbDefinitionsCommon.pas:3137). */
const RESERVED_ALIASES: Record<string, string | undefined> = { '-1': 'None', '-2': 'Player' };

/** How a script object binding reads: the bound record as its own cell shows it, then the alias
 *  slot. xEdit resolves an alias number past the two reserved ones through the owning quest's own
 *  alias list; the compare wire carries no alias list, so the number stands for itself — which is
 *  also what xEdit itself prints with `wbResolveAlias` off. */
function scriptObject(row: SummaryRow): string {
  const alias = row.member('alias').label;
  return `${row.member('object').label}, Alias[${RESERVED_ALIASES[alias] ?? alias}]`;
}

/** The member each single-valued property leaf keeps its value in. A leaf whose value is a list or
 *  a nested struct is absent: xEdit passes a property's own value through only one level deep
 *  (`SetSummaryPassthroughMaxDepth(1)`), so such a property reads by name and kind alone and its
 *  value lives on the rows it expands to. */
const PROPERTY_VALUE_MEMBERS: Record<string, string | undefined> = {
  ScriptBoolProperty: 'data_bool',
  ScriptFloatProperty: 'data_float',
  ScriptIntProperty: 'data_int',
  ScriptStringProperty: 'data_string',
};

/** What a value wears when it is read as a member of the script-property union: its name, the kind
 *  the schema calls its leaf, and itself. Read anywhere else, a value is just itself — which is how
 *  one class serves both as a property and as an element of a list of bindings. */
function asProperty(row: SummaryRow, value: string | undefined): string {
  if (row.kind == null) return value ?? '';
  return `${row.member('name').label}: ${row.kind}${value == null ? '' : ` = ${value}`}`;
}

function scriptPropertyValue(row: SummaryRow): string | undefined {
  const member = PROPERTY_VALUE_MEMBERS[row.leaf];
  return member == null ? undefined : row.member(member).label;
}

/** `ScriptName(<each property>)` — xEdit passes the properties list straight through rather than
 *  counting it, and joins its elements the way it joins any summary list. Its own length caps
 *  (`SetSummaryPassthroughMaxLength`, 80 here and 100 on the scripts list) are xEdit's answer to a
 *  fixed-width tree column; the cell this lands in already ellipsizes at its own width, so the
 *  summary carries every property and lets the grid decide how much of it fits. */
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

/** Which member of this struct names the concrete class its object is, if any. */
const discriminatorOf = (meta: FieldMetadata | undefined): string | undefined =>
  meta?.fields?.find(f => f.isDiscriminator)?.name;

/** The leaf type this object is, which is what the table is keyed by: the value of whichever member
 *  the schema itself marks as the discriminator — `concrete_type` for a Loqui union, `value_type`
 *  for OMOD's, never a name written here — or the type name the schema declares, for a struct that
 *  is not a union and so has no discriminator. A leaf with a discriminator is answered by it alone:
 *  it says which class the value turned out to be, where the declared name says only which class
 *  the schema promised, and a union is exactly where the two disagree. */
function leafOf(meta: FieldMetadata | undefined, value: unknown): string | null | undefined {
  const discriminator = discriminatorOf(meta);
  if (discriminator == null) return meta?.leafTypeName;
  const leaf = (value as Record<string, unknown> | null)?.[discriminator];
  // A union whose own value names no leaf has none, rather than the base class the schema declares:
  // a concrete base is one of its own leaves (#701), so falling back there would hand an object of
  // unknown leaf the base leaf's own reading.
  return typeof leaf === 'string' ? leaf : undefined;
}

/** The formatter this element reads by, and the leaf it was found for. A leaf the table has no
 *  entry of its own for reads by its declared base's entry, since a union's leaves mostly share one
 *  reading and differ only in which member holds the value — fifteen script-property leaves, one
 *  entry. The base is reached only once the value has named a leaf: an object whose value names no
 *  leaf reads as nothing at all, because a concrete base is one of its own leaves (#701) and that
 *  is a different claim from "one of the leaves, and the table knows only the family's reading". */
function summarizerFor(
  meta: FieldMetadata | undefined, value: unknown,
): { summarize: Summarizer; leaf: string } | undefined {
  const leaf = leafOf(meta, value);
  if (leaf == null) return undefined;
  const summarize = PRESENTATION_TABLE[leaf]
    ?? (meta?.leafTypeName == null ? undefined : PRESENTATION_TABLE[meta.leafTypeName]);
  return summarize == null ? undefined : { summarize, leaf };
}

/** What a container with no reading of its own shows, here and on its own row (DiffRow). */
const COLLAPSED_PLACEHOLDER = '{…}';

const memberPath = (path: readonly string[]): PathSegment[] =>
  path.map(name => ({ kind: 'member', name }));

/** The diff of a member of this element, by member path — the branch of the same tree the panel
 *  renders that member's own row from. */
function diffAt(diff: FieldDiff, path: readonly string[]): FieldDiff | undefined {
  let cur: FieldDiff | undefined = diff;
  for (const name of path) cur = cur?.children?.find(c => c.fieldName === name) ?? undefined;
  return cur;
}

/**
 * What each column's cell reads on this row while it is collapsed. Empty for every row whose leaf
 * has no entry in the table — which is where the grid's own "{…}" stands.
 */
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

/** How one element reads in one column, or nothing when its leaf has no entry in the table. */
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
