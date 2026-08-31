import { describe, it, expect } from 'vitest';
import { copyTargetPlugins } from '../copyTargetPlugins';
import type { PluginMetadata } from '../ApiClient';

// The destination-picker's exclusion rule differs per gesture — a plugin cannot
// hold two overrides of the same record, but copying into a fresh record with its own FormID is
// the ordinary way to author one from a template already in the same plugin. Pure and
// vscode-free, so both branches are verifiable without stubbing the picker's UI at all.

function plugin(name: string, isImmutable = false): PluginMetadata {
  return {
    name, path: `/data/${name}`, loadOrderIndex: 0, isLight: false, isMaster: false,
    masters: [], recordCount: 0, isImmutable, enabled: true, winning: true, participates: true, inLoadOrder: true, origin: 'Data', masterIssues: [],
    hasMatchingRecords: true,
  };
}

describe('copyTargetPlugins (#347 / #494)', () => {
  const allPlugins = [plugin('Source.esp'), plugin('Other.esp'), plugin('ThirdOverride.esp'), plugin('Base.esm', true)];

  it('copy-as-new keeps the source plugin as a candidate — a new record gets its own FormID and coexists with the source', () => {
    // An empty carrying list — new-record mode ignores it regardless of what's passed
    // (proven separately below), but the ordinary caller has no reason to compute one for it.
    const names = copyTargetPlugins(allPlugins, 'copy-as-new', []).map(p => p.name);
    expect(names).toEqual(['Source.esp', 'Other.esp', 'ThirdOverride.esp']);
  });

  it('copy-as-new is unaffected by a non-empty carrying list — xEdit applies this exclusion only to override mode', () => {
    const names = copyTargetPlugins(allPlugins, 'copy-as-new', ['Source.esp', 'ThirdOverride.esp']).map(p => p.name);
    expect(names).toEqual(['Source.esp', 'Other.esp', 'ThirdOverride.esp']);
  });

  it('copy-as-override excludes the source plugin — a plugin cannot override itself', () => {
    const names = copyTargetPlugins(allPlugins, 'copy-as-override', ['Source.esp']).map(p => p.name);
    expect(names).toEqual(['Other.esp', 'ThirdOverride.esp']);
  });

  // xEdit parity (xeMainForm.pas:3023-3042): a *second*
  // plugin that already overrides the record, distinct from the source, must also be excluded.
  // Rival 1 (source-only exclusion) would keep 'ThirdOverride.esp' in
  // the result here and fail this assertion.
  it('copy-as-override excludes every plugin already carrying the record, not only the source', () => {
    const names = copyTargetPlugins(allPlugins, 'copy-as-override', ['Source.esp', 'ThirdOverride.esp']).map(p => p.name);
    expect(names).toEqual(['Other.esp']);
  });

  it('never offers an immutable plugin as a destination, for either gesture', () => {
    expect(copyTargetPlugins(allPlugins, 'copy-as-new', []).map(p => p.name)).not.toContain('Base.esm');
    expect(copyTargetPlugins(allPlugins, 'copy-as-override', ['Source.esp']).map(p => p.name)).not.toContain('Base.esm');
  });
});
