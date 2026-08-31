import { describe, it, expect } from 'vitest';
import { columnKey } from './types';
import type {   CompareOverride, CompareResult, ConditionCompare, ConditionDiff, ConditionGroupDiff, FieldDiff,   FieldMetadata, FieldValue, FormKeyResolution, ParsedCondition, ParsedConditionParam, RecordDetail, VmadCompare,   VmadPropertyDiff, VmadScriptDiff, } from './types';
import type { PluginInfo } from './RecordPanelClient';
import type { components } from '../../src/medit/generated/api';

type WireSchemas = components['schemas'];

// This file's type-level checks below are enforced by `tsc -p webview/tsconfig.json
// --noEmit` (the second step of `npm run build`), not by `vitest run` (`npm run test:unit`) —
// vitest transpiles test files with esbuild, which strips types without validating them. Only the
// `describe('columnKey', ...)` block below is a genuine vitest runtime suite.

// Every hand-written interface in `types.ts`/`RecordPanelClient.ts` that
// mirrors a generated wire DTO gets one containment check here — every key the hand type declares
// must also exist on the generated schema for the same DTO. A backend rename (e.g.
// WinnerPlugin -> WinnerColumn) drops the renamed key from the generated side, so
// `KeysContainedIn` stops resolving to `never` and `AssertNoMissingKeys` fails to compile, naming
// the stale key in the error (e.g. `Type '"winnerColumn"' does not satisfy the constraint
// 'never'.`).
//
// Deliberately not a value-level/assignability check (`Hand extends Wire`): the generated schema
// types every property as optional-and-nullable regardless of the C# side's actual
// nullability/required-ness (an OpenAPI-generator gap, not specific to any one field),
// so hand-written -> generated is vacuously satisfiable regardless of renames (no
// required members on the target) and generated -> hand-written fails on nullability even when
// names agree. Key containment is exactly the tool that catches a rename and ignores nullability.
type KeysContainedIn<Hand, Wire> = Exclude<keyof Hand, keyof Wire>;
type AssertNoMissingKeys<T extends never> = T;

// #627: the generator now reports C# nullability and enum-string-ness honestly, and these pin that
// it keeps doing so. Type-level by necessity — "this property is not optional" is not an
// observable any runtime test can assert, so it is asserted where the type system actually checks
// it: `tsc -p webview/tsconfig.json --noEmit`, the second step of `npm run build`.
//
// `Exact` is a bidirectional-extends pair rather than a bare `extends`, because
// `string extends string | null | undefined` is true — a one-way check would have passed against
// the very shape this exists to reject.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// A non-nullable C# `string Name` is a required, non-nullable wire property. Before the schema
// filter learned to emit `required`, this was `string | null | undefined` and every consumer
// re-asserted non-nullability by hand.
export type CheckNonNullableIsRequired = Assert<Exact<WireSchemas['PluginResponse']['name'], string>>;

// The other direction, and the one that matters more: a genuinely nullable C# member
// (`int? LoadOrderIndex`, ADR-0044's honest null for a copy no plugins.txt line names) must NOT be
// swept into `required`. A filter that marked every property required would pass the check above
// and fail this one.
export type CheckHonestNullableSurvives =
  Assert<Exact<WireSchemas['PluginResponse']['loadOrderIndex'], number | null | undefined>>;

// An enum the global JsonStringEnumConverter serializes as a string must be described as one. This
// was `0 | 1 | 2` while the wire carried "None"/"Modified"/"Added", which is what forced the
// `toWorkingTreeState` trust-cast the repository used to carry.
export type CheckWireEnumIsStringUnion =
  Assert<Exact<WireSchemas['WorkingTreeState'], 'None' | 'Modified' | 'Added'>>;

// FieldMetadata: `readOnly`/`defaultValue` are synthesized only by the VMAD/Condition tree
// adapters (see the fields' own doc comments in types.ts) — the backend never emits them, so
// they're excluded from the wire-containment check rather than expected to appear on the schema.
export type CheckFieldMetadata =
  AssertNoMissingKeys<KeysContainedIn<Omit<FieldMetadata, 'readOnly' | 'defaultValue'>, WireSchemas['FieldMetadata']>>;
export type CheckFieldValue = AssertNoMissingKeys<KeysContainedIn<FieldValue, WireSchemas['FieldValue']>>;
export type CheckFormKeyResolution =
  AssertNoMissingKeys<KeysContainedIn<FormKeyResolution, WireSchemas['FormKeyResolution']>>;
export type CheckRecordDetail = AssertNoMissingKeys<KeysContainedIn<RecordDetail, WireSchemas['RecordDetail']>>;
export type CheckCompareOverride =
  AssertNoMissingKeys<KeysContainedIn<CompareOverride, WireSchemas['CompareOverride']>>;

// FieldDiff: `wirePath`/`collapsedSummary` are synthesized by
// vmadTreeAdapter.ts/conditionTreeAdapter.ts (see each field's own doc comment in types.ts)
// for rows the backend never sends this shape for — excluded for the same reason as
// FieldMetadata's readOnly/defaultValue above.
export type CheckFieldDiff = AssertNoMissingKeys<
  KeysContainedIn<Omit<FieldDiff, 'wirePath' | 'collapsedSummary'>, WireSchemas['FieldDiff']>
>;
export type CheckVmadPropertyDiff =
  AssertNoMissingKeys<KeysContainedIn<VmadPropertyDiff, WireSchemas['VmadPropertyDiff']>>;
export type CheckVmadScriptDiff =
  AssertNoMissingKeys<KeysContainedIn<VmadScriptDiff, WireSchemas['VmadScriptDiff']>>;
export type CheckVmadCompare = AssertNoMissingKeys<KeysContainedIn<VmadCompare, WireSchemas['VmadCompare']>>;
export type CheckParsedConditionParam =
  AssertNoMissingKeys<KeysContainedIn<ParsedConditionParam, WireSchemas['ParsedConditionParam']>>;
export type CheckParsedCondition =
  AssertNoMissingKeys<KeysContainedIn<ParsedCondition, WireSchemas['ParsedCondition']>>;
export type CheckConditionDiff = AssertNoMissingKeys<KeysContainedIn<ConditionDiff, WireSchemas['ConditionDiff']>>;
export type CheckConditionGroupDiff =
  AssertNoMissingKeys<KeysContainedIn<ConditionGroupDiff, WireSchemas['ConditionGroupDiff']>>;
export type CheckConditionCompare =
  AssertNoMissingKeys<KeysContainedIn<ConditionCompare, WireSchemas['ConditionCompare']>>;
export type CheckCompareResult = AssertNoMissingKeys<KeysContainedIn<CompareResult, WireSchemas['CompareResult']>>;

// PluginInfo (RecordPanelClient.ts): a deliberate structural subset of the backend's
// PluginResponse (its own doc comment) — every key it does declare must still exist on the wire.
export type CheckPluginInfo = AssertNoMissingKeys<KeysContainedIn<PluginInfo, WireSchemas['PluginResponse']>>;

// ADR-0036: columnKey() is the frontend's own compound column identity, meant to agree
// with the backend's ColumnKey.Of (MEditService.Core/Queries/ColumnKey.cs) for the same
// (plugin, origin) pair. The trap: with one origin per filename today, almost
// any implementation looks green — the genuinely red case is two columns sharing a filename but
// differing in origin, which must never collapse to the same key.
describe('columnKey', () => {
  it('the same plugin and origin always produce the same key', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe(columnKey('Shared.esp', 'ModA'));
  });

  it('the same filename under two different origins produces two distinct keys', () => {
    expect(columnKey('Shared.esp', 'ModA')).not.toBe(columnKey('Shared.esp', 'ModB'));
  });

  // Elision parity with the backend: a Data-directory-resolved plugin's key is the plain
  // filename, not `filename|Data` — every existing single-origin fixture keeps producing the
  // plain-filename keys it always has, in its own original casing (this helper preserves
  // plugin/origin casing verbatim in the returned key — see columnKey()'s own doc comment for why
  // only the Data-origin *check* is case-folded, not the whole output).
  it('elides the reserved Data origin, matching the backend exactly', () => {
    expect(columnKey('Shared.esp', 'Data')).toBe('Shared.esp');
  });

  // ADR-0036: origin is not omittable — a literal `null` is the only way to reach the
  // elided-Data path, covered by 'treats a literal null origin the same as a missing one' below.

  // Case-folding is scoped to the Data-origin check only (unlike the backend, which doesn't fold
  // at all — see columnKey()'s doc comment): "Data"/"data"/"DATA" must all elide the same way
  // regardless of which casing a given response happens to use.
  it('case-folds the Data-origin check itself, however the origin is cased', () => {
    expect(columnKey('Shared.esp', 'DATA')).toBe(columnKey('Shared.esp', 'data'));
    expect(columnKey('Shared.esp', 'DATA')).toBe('Shared.esp');
  });

  it('a non-Data origin appends after the delimiter, preserving both halves\' own casing', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe('Shared.esp|ModA');
  });

  // The generated wire schema types `origin` as `string | null` on every DTO that
  // carries it (CompareOverride/PluginResponse in generated/api.ts) even though the
  // backend can't actually produce a null there (see columnKey()'s own doc comment) — a `null`
  // makes it through RecordPanelClient's unchecked `as` cast into these hand types regardless of
  // what they claim, so `columnKey` must tolerate it exactly like the elided Data origin rather
  // than throwing inside `.toLowerCase()`.
  it('treats a literal null origin the same as the Data origin, not a crash', () => {
    expect(columnKey('Shared.esp', null)).toBe(columnKey('Shared.esp', 'Data'));
    expect(columnKey('Shared.esp', null)).toBe('Shared.esp');
  });
});
