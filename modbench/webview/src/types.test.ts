import { describe, it, expect } from 'vitest';
import { columnKey } from './types';
import type { components } from '../../src/medit/generated/api';

type WireSchemas = components['schemas'];

// The type-level checks below are enforced by `tsc -p webview/tsconfig.json --noEmit` (the second
// step of `npm run build`), not by `vitest run` (`npm run test:unit`) — vitest transpiles test
// files with esbuild, which strips types without validating them. Only the
// `describe('columnKey', ...)` block is a genuine vitest runtime suite.
//
// The key-containment scaffolding that used to fill this file (`KeysContainedIn`/
// `AssertNoMissingKeys`, one check per hand-written mirror of a wire DTO) is gone. It existed for
// exactly one reason, stated in its own comment: the generated schema typed every property
// optional-and-nullable regardless of the C# side, which made an ordinary assignability check
// vacuous in one direction and impossible in the other, leaving key containment as the only tool
// that could still catch a backend rename. With the schema honest (#627) the mirrors *are* the
// generated types, so a rename is a compile error at every use site and there is nothing left for
// a containment check to add.

// #627: the generator now reports C# nullability and enum-string-ness honestly, and these three
// pin that it keeps doing so. Type-level by necessity — "this property is not optional" is not an
// observable any runtime test can assert.
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
