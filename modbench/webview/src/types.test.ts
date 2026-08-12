import { describe, it, expect } from 'vitest';
import { columnKey } from './types';
import type { ConditionDiff, FieldDiff, VmadPropertyDiff, VmadScriptDiff } from './types';
import type { components } from '../../src/medit/generated/api';

type WireSchemas = components['schemas'];

// #272 review: every fixture in this suite used to hand-build `winnerPlugin` on both the type
// (types.ts) and the test data, so a real backend rename (WinnerPlugin -> WinnerColumn, landed on
// FieldDiff/ConditionDiff/VmadPropertyDiff/VmadScriptDiff — see generated/api.ts) went unnoticed:
// the hand type and the hand fixtures agreed with each other and disagreed with the wire. `sharedKey`
// only *compiles* when `K` is a key of *both* the hand-authored interface and the generated
// (regenerated-from-the-live-backend) wire schema for the same DTO — if either side renames the
// field without the other following, the intersection drops the key and this file fails to
// type-check (the `.toBe(key)` below is a real runtime assertion too, just a trivially-true one:
// the actual guarantee is the generic constraint, not the returned value).
//
// Enforcement note: `vitest run` (`npm run test:unit`) does not type-check test files — it
// transpiles with esbuild, which strips types without validating them. This check is caught by
// `npm run build`'s `tsc -p webview/tsconfig.json --noEmit` pass, which includes this file
// (`webview/tsconfig.json`'s `include: ["src"]`). Confirmed by temporarily reverting the
// `winnerColumn` rename in types.ts alone: `npm run build` fails on this file with "Type
// '\"winnerColumn\"' does not satisfy the constraint 'never'" for every DTO below; reverting the
// generated `api.ts` alone (simulating an un-propagated backend rename) fails the same way.
function sharedKey<Hand, Wire, K extends keyof Hand & keyof Wire>(key: K): K {
  return key;
}

describe('winnerColumn stays in sync with the wire (#272 regression)', () => {
  it('FieldDiff.winnerColumn / ConditionDiff.winnerColumn / VmadPropertyDiff.winnerColumn / VmadScriptDiff.winnerColumn all still exist on both the hand type and the generated wire schema', () => {
    expect(sharedKey<FieldDiff, WireSchemas['FieldDiff'], 'winnerColumn'>('winnerColumn')).toBe('winnerColumn');
    expect(sharedKey<ConditionDiff, WireSchemas['ConditionDiff'], 'winnerColumn'>('winnerColumn')).toBe('winnerColumn');
    expect(sharedKey<VmadPropertyDiff, WireSchemas['VmadPropertyDiff'], 'winnerColumn'>('winnerColumn')).toBe('winnerColumn');
    expect(sharedKey<VmadScriptDiff, WireSchemas['VmadScriptDiff'], 'winnerColumn'>('winnerColumn')).toBe('winnerColumn');
  });
});

// #272 / ADR-0036: columnKey() is the frontend's own compound column identity, meant to agree
// with the backend's ColumnKey.Of (MEditService.Core/Queries/ColumnKey.cs) for the same
// (plugin, origin) pair. The trap this ticket names: with one origin per filename today, almost
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

  // #275 / ADR-0036: origin is no longer omittable (the contract step removed the default that
  // let a caller skip it) — a literal `null` is the only way left to reach the elided-Data path,
  // covered by 'treats a literal null origin the same as a missing one' below.

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

  // #272 review: the generated wire schema types `origin` as `string | null` on every DTO that
  // carries it (CompareOverride/PendingChange/PluginResponse in generated/api.ts) even though the
  // backend can't actually produce a null there (see columnKey()'s own doc comment) — a `null`
  // makes it through RecordSessionClient's unchecked `as` cast into these hand types regardless of
  // what they claim, so `columnKey` must tolerate it exactly like the elided Data origin rather
  // than throwing inside `.toLowerCase()`.
  it('treats a literal null origin the same as the Data origin, not a crash', () => {
    expect(columnKey('Shared.esp', null)).toBe(columnKey('Shared.esp', 'Data'));
    expect(columnKey('Shared.esp', null)).toBe('Shared.esp');
  });
});
