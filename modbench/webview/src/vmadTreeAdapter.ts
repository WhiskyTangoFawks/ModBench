// Issue #231: maps VMAD (Papyrus script data) into the same node shape the compare grid's
// ordinary fields already use (FieldDiff + FieldMetadata), so VmadSection's bespoke row/cell
// renderers can be deleted and VMAD rows become ordinary rows in the one tree — focus, keyboard,
// clipboard, drag, conflict coloring, and pending columns all come from DiffRow/RecordPanel
// unchanged, nothing VMAD-specific re-derives them.
//
// Shape: one top-level synthesized FieldDiff per script (a struct-like container: no editable
// value of its own, its own "Flags" a read-only child — VmadSection's inline flag <select> moves
// to a right-click "Set Script Flags…" command, issue #231's own "structural ops reached the same
// way every other structural op is"). Each script's properties are its struct members, each
// carrying its own `wirePath` (`VMAD\Script\Prop`) — VMAD restages a property's whole value
// atomically regardless of how deep an edit inside it happens (structCtx/arrayCtx in the deleted
// VmadSection always restaged at the property's own top path), which is exactly what a
// `wirePath`-bearing FieldDiff triggers in RecordPanel's row-builder (subtreeFor): a fresh
// restage root starts there, so a struct/array member many levels below still collapses back to
// one atomic PendingChange at the property's path, never the property's own container script.
//
// Struct and ArrayOfStruct (structList) properties are VMAD's one genuine exception to "the
// generic setAtPath already produces the right wire shape": their wire value is the backend's own
// raw node tree (VmadCodec.cs's VmadStructEntry[]/VmadStructInstance[] — `{name, type, boolValue,
// ..., members}`), not a plain nested object/array, and this issue makes no backend/API change to
// alter that. Those two kinds' FieldDiff carries `commitOverride` — the one escape hatch
// RecordPanel's commitHere consults instead of setAtPath — built by walking the raw node tree the
// same way the deleted VmadSection's nodeAt/setNodeValue always did, just addressed by the shared
// PathSegment chain instead of a VMAD-only (string | number)[] convention.
import type {
  FieldDiff, FieldMetadata, VmadCompare, VmadPropertyDiff, VmadScriptDiff } from './types';
import { opScalarKind, SCRIPT_FLAGS } from './vmadOps';
import { sparseArrayByPlugin, aggregateConflictAll } from './recordUtils';

type ScalarKind = 'bool' | 'int' | 'float' | 'string';

function scalarMeta(kind: ScalarKind): FieldMetadata {
  return { name: '', type: kind, isArray: false, validFormKeyTypes: [], enumValues: [] };
}

// Issue #231: the new synthesized leaf type for VMAD's (FormKey, alias) object property — the
// composite cell that reads/commits it (slice 4) composes the shared FormKeyCell plus an alias
// input, the same shape #229's VmadObjectEditor already used.
const OBJECT_META: FieldMetadata = { name: '', type: 'vmadObject', isArray: false, validFormKeyTypes: [], enumValues: [] };

function scalarKindOf(p: VmadPropertyDiff): ScalarKind {
  return opScalarKind(p.types[p.winnerColumn] ?? '') ?? 'string';
}

// A property's `values`/`cellStates`/`types` are each only ever keyed by the plugins that
// actually carry data for it — the union of all three is "every plugin this property might say
// anything about," needed for kinds (variable) whose displayed text isn't sourced from `values`
// directly.
function allPluginsOf(p: VmadPropertyDiff): string[] {
  return [...new Set([...Object.keys(p.values), ...Object.keys(p.cellStates), ...Object.keys(p.types)])];
}

interface Built { diff: FieldDiff; meta: FieldMetadata }

// ── scalar / object (plain leaves — the generic setAtPath already produces their wire shape) ──

function buildScalarOrObject(p: VmadPropertyDiff): Built {
  const isObject = p.kind === 'object';
  return {
    diff: {
      fieldName: p.name,
      values: p.values,
      winnerColumn: p.winnerColumn,
      winnerValue: p.values[p.winnerColumn] ?? null,
      cellStates: p.cellStates,
      conflictAll: aggregateConflictAll(p.cellStates),
      resolutions: isObject ? p.resolutions : undefined },
    meta: isObject ? OBJECT_META : scalarMeta(scalarKindOf(p)) };
}

// ── variable (never editable — VmadSection's renderLeafCell always fell through to plain `read`
// content for this kind; `readOnly` reproduces that with the same mechanism the Condition
// section's AND/OR gate uses, rather than a bespoke non-editing leaf renderer) ──────────────────

function variableText(p: VmadPropertyDiff, plugin: string): string | null {
  const present = plugin in p.cellStates || p.values[plugin] != null;
  if (!present) return null;
  return p.types[plugin]?.startsWith('ArrayOf') ? '(variables)' : '(Variable)';
}

function buildVariable(p: VmadPropertyDiff): Built {
  const values: Record<string, unknown> = {};
  for (const plugin of allPluginsOf(p)) values[plugin] = variableText(p, plugin);
  return {
    diff: {
      fieldName: p.name, values, winnerColumn: p.winnerColumn,
      winnerValue: values[p.winnerColumn] ?? null, cellStates: p.cellStates,
      conflictAll: aggregateConflictAll(p.cellStates) },
    meta: { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [], readOnly: true } };
}

// ── array (ArrayOf Bool/Int/Float/String/Object — scalar/object elements only; ArrayOfStruct is
// its own kind, structList, below) ──────────────────────────────────────────────────────────────

// Issue #227/#231: VMAD arrays are always plain, position-addressed and never "sorted" (wbArrayS
// has no VMAD analogue) — reusing the exact fixture shape ordinary unsorted arrays already use
// (`values` a real sparse array per plugin, children fieldName `"[i]"`) means the *existing*
// array-element machinery (Insert/Delete/Ctrl+↑/↓, the right-click menu, computeArrayOps) applies
// to a VMAD array with no VMAD-specific code in DiffRow/RecordPanel at all — this is the "ordinary
// rows" unification actually paying off, not merely a display convenience.
//
// Issue #168: reconstructing each plugin's own array from its per-element `values` must skip a
// position where this plugin is null (past its own real length — VmadConflictClassifier always
// reports every plugin at every union-aligned position) rather than carry the null through as
// filler; sparseArrayByPlugin (recordUtils.ts, shared with conditionTreeAdapter's own identical
// need) is what does that.
function buildArray(p: VmadPropertyDiff): Built {
  const children = p.children ?? [];
  const elementBuilds = children.map(c => buildScalarOrObject(c));
  const values = sparseArrayByPlugin(children.map(c => c.values));
  // Matches the deleted VmadSection's own default ('Int') when the array is currently empty.
  const elementType = elementBuilds[0]?.meta ?? scalarMeta('int');
  const arrayChildren = elementBuilds.map((b, i) => ({ ...b.diff, fieldName: `[${i}]` }));
  return {
    diff: {
      fieldName: p.name, values, winnerColumn: p.winnerColumn, winnerValue: values[p.winnerColumn] ?? null,
      cellStates: p.cellStates,
      conflictAll: aggregateConflictAll(p.cellStates, arrayChildren),
      children: arrayChildren },
    meta: { name: '', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [], elementType } };
}

// ── struct / structList — the raw-node exception ────────────────────────────────────────────────
//
// Ported from the deleted VmadSection's nodeAt/setNodeValue: a struct's raw value (`p.raw`) is a
// flat node list (VmadStructEntry[]); a structList's is a list of node lists, one per instance
// (VmadStructInstance[], i.e. Record<string,unknown>[][]) — a "leading index" selects the
// instance, every hop after it is a member-name lookup, arbitrarily deep (VmadCodec.cs: "the
// (de)serializer descends to arbitrary depth"). `PathSegment`'s `index`/`member` kinds map
// directly onto that shape 1:1 (a structList's own metadata puts its instances behind an 'array'
// dispatch in RecordPanel, so an instance's own path hop is always `index`; every hop inside an
// instance is a struct dispatch, always `member`) — `sortKey` never appears in a struct/structList
// path, since nothing inside one is a sorted array.

// A struct member's own FieldMetadata needs its own `name` set (the generic per-kind builders
// above return a reusable, unnamed meta) — this is the one place that naming happens for a
// member, mirroring how buildScript names each of its own property fields below.
function buildMember(c: VmadPropertyDiff): Built {
  const built = buildProperty(c);
  return { ...built, meta: { ...built.meta, name: c.name } };
}

function buildStruct(p: VmadPropertyDiff): Built {
  const members = (p.children ?? []).map(buildMember);
  const memberDiffs = members.map(m => m.diff);
  return {
    diff: {
      fieldName: p.name,
      values: p.raw ?? {},
      winnerColumn: p.winnerColumn,
      winnerValue: p.raw?.[p.winnerColumn] ?? null,
      cellStates: p.cellStates,
      conflictAll: aggregateConflictAll(p.cellStates, memberDiffs),
      children: memberDiffs },
    meta: { name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [], fields: members.map(m => m.meta) } };
}

function buildStructList(p: VmadPropertyDiff): Built {
  const instances = p.children ?? [];
  const instanceBuilds = instances.map(buildStruct);
  const values = p.raw ?? {};
  const instanceChildren = instanceBuilds.map((b, i) => ({ ...b.diff, fieldName: `[${i}]` }));
  return {
    diff: {
      fieldName: p.name,
      values,
      winnerColumn: p.winnerColumn,
      winnerValue: values[p.winnerColumn] ?? null,
      cellStates: p.cellStates,
      conflictAll: aggregateConflictAll(p.cellStates, instanceChildren),
      children: instanceChildren },
    meta: {
      name: '', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
      elementType: instanceBuilds[0]?.meta ?? { name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [], fields: [] } } };
}

function buildProperty(p: VmadPropertyDiff): Built {
  switch (p.kind) {
    case 'scalar': case 'object': return buildScalarOrObject(p);
    case 'variable': return buildVariable(p);
    case 'array': return buildArray(p);
    case 'struct': return buildStruct(p);
    case 'structList': return buildStructList(p);
  }
}

// ── script container ────────────────────────────────────────────────────────────────────────────

function buildFlagsChild(s: VmadScriptDiff): FieldDiff {
  return {
    fieldName: 'Flags',
    values: s.flags,
    winnerColumn: s.winnerColumn,
    winnerValue: s.flags[s.winnerColumn] ?? null,
    cellStates: s.cellStates,
    conflictAll: aggregateConflictAll(s.cellStates) };
}

const FLAGS_META: FieldMetadata = {
  name: 'Flags', type: 'enum', isArray: false, validFormKeyTypes: [], enumValues: [...SCRIPT_FLAGS], readOnly: true };

// One script → one top-level synthesized FieldDiff (a struct-like container row: `{…}` collapsed,
// no value of its own — script/property structural ops, including this row's own Add
// Property/Remove Script/Set Flags…, are right-click-menu commands, issue #231's own "reached the
// same way every other structural op is", not rendered here). Every property child carries its
// own `wirePath`, independent of the container and of every sibling.
function buildScript(s: VmadScriptDiff): { diff: FieldDiff; meta: FieldMetadata } {
  const propertyBuilds = s.properties.map(p => ({ name: p.name, ...buildProperty(p) }));
  const children: FieldDiff[] = [
    buildFlagsChild(s),
    ...propertyBuilds.map(({ name, diff }) => ({ ...diff, wirePath: `VMAD\\${s.name}\\${name}`, vmadOpKind: 'property' as const })),
  ];
  const fields: FieldMetadata[] = [FLAGS_META, ...propertyBuilds.map(({ name, meta }) => ({ ...meta, name }))];
  return {
    diff: {
      fieldName: s.name,
      values: s.flags,
      winnerColumn: s.winnerColumn,
      winnerValue: s.flags[s.winnerColumn] ?? null,
      cellStates: s.cellStates,
      conflictAll: aggregateConflictAll(s.cellStates, children),
      children,
      vmadOpKind: 'script' },
    meta: { name: s.name, type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [], fields } };
}

export interface VmadTreeRows {
  diffs: FieldDiff[];
  metaMap: Record<string, FieldMetadata>;
}

// Issue #119/#231: a VMAD-*capable* record type (RecordPanel's own `hasVmad` gate) needs a place
// for "Add Script" to live even when it currently has *no* scripts at all — unlike a condition-
// owning field (always reflected with an empty list, never simply absent), `vmad` itself can be
// entirely `null`/`undefined` for such a record. One always-present wrapper row (an ordinary
// struct container — `{…}` collapsed, focusable/draggable/right-click-able exactly like any other
// container row, not a bespoke header) gives that a stable home regardless of script count. Named
// "Scripts (VMAD)", matching the deleted VmadSection's own header text, so existing "does/doesn't
// show a Scripts (VMAD) section" behavior (issue #119/#179) is unchanged in substance — only its
// rendering mechanism (an ordinary row, not a hand-drawn section) is new.
const WRAPPER_NAME = 'Scripts (VMAD)';

// The one exported entry point — RecordPanel merges `diffs` into its own `diffs` array and
// `metaMap` into its own `fieldMetaMap` (both additive; "Scripts (VMAD)" and every VMAD script
// name are reserved names SchemaReflector already excludes from the generic reflection pass).
// Callers gate the call itself on `hasVmad` (RecordPanel) — this function always wraps, even with
// zero scripts, since that's exactly the "capable but currently empty" case the wrapper exists for.
export function buildVmadRows(vmad: VmadCompare | null | undefined): VmadTreeRows {
  const scriptBuilds = (vmad?.scripts ?? []).map(buildScript);
  const scriptDiffs = scriptBuilds.map(b => b.diff);
  const wrapper: FieldDiff = {
    fieldName: WRAPPER_NAME,
    values: {},
    winnerColumn: '',
    winnerValue: null,
    cellStates: {},
    conflictAll: aggregateConflictAll({}, scriptDiffs),
    children: scriptDiffs,
    vmadOpKind: 'scripts' };
  const wrapperMeta: FieldMetadata = {
    name: WRAPPER_NAME, type: 'struct', isArray: false, validFormKeyTypes: [], enumValues: [],
    fields: scriptBuilds.map(b => b.meta) };
  return { diffs: [wrapper], metaMap: { [WRAPPER_NAME]: wrapperMeta } };
}
