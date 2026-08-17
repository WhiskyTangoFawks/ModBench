import { describe, it, expect } from 'vitest';
import { copyTargetPlugins } from '../copyTargetPlugins';
import type { PluginMetadata } from '../ApiClient';

// #347: the destination-picker's exclusion rule differs per gesture — a plugin cannot override
// itself, but copying into a fresh record with its own FormID is the ordinary way to author one
// from a template already in the same plugin. Pure and vscode-free, so both branches are
// verifiable without stubbing the picker's UI at all.

function plugin(name: string, isImmutable = false): PluginMetadata {
  return {
    name, path: `/data/${name}`, loadOrderIndex: 0, isLight: false, isMaster: false,
    masters: [], recordCount: 0, isImmutable, origin: 'Data', masterIssues: [],
  };
}

describe('copyTargetPlugins (#347)', () => {
  const allPlugins = [plugin('Source.esp'), plugin('Other.esp'), plugin('Base.esm', true)];

  it('copy-as-new keeps the source plugin as a candidate — a new record gets its own FormID and coexists with the source', () => {
    const names = copyTargetPlugins(allPlugins, 'Source.esp', 'copy-as-new').map(p => p.name);
    expect(names).toEqual(['Source.esp', 'Other.esp']);
  });

  it('copy-as-override excludes the source plugin — a plugin cannot override itself', () => {
    const names = copyTargetPlugins(allPlugins, 'Source.esp', 'copy-as-override').map(p => p.name);
    expect(names).toEqual(['Other.esp']);
  });
});
