import { describe, it, expect } from 'vitest';
import { COPY_MODE_ITEMS, copiesWritten, copyDestinationItems, heldCopies } from '../copyPicks';
import type { PluginMetadata, RecordAddress } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';

function plugin(name: string, origin: string, loadOrderIndex: number, facts: Partial<PluginMetadata> = {}): PluginMetadata {
  return pluginMetadataFixture({ name, origin, loadOrderIndex, isTracked: true, isImmutable: false, ...facts });
}

const npc: RecordAddress = { formKey: '000801:Source.esp', plugin: 'Source.esp', origin: 'SourceMod' };
const faction: RecordAddress = { formKey: '000802:Source.esp', plugin: 'Source.esp', origin: 'SourceMod' };
const elsewhere: RecordAddress = { formKey: '000803:Other.esp', plugin: 'Other.esp', origin: 'OtherMod' };

// plugins.md, Pickers, Copy: a pick of the mode, then a pick of the destination.
describe('the mode pick', () => {
  it('offers override and new, override first as xEdit\'s navigator does', () => {
    expect(COPY_MODE_ITEMS.map((item) => item.mode)).toEqual(['Override', 'New']);
  });
});

describe('the destination pick', () => {
  const plugins = [
    plugin('Source.esp', 'SourceMod', 3),
    plugin('Patch.esp', 'PatchMod', 5),
    plugin('Untracked.esp', 'UntrackedMod', 6, { isTracked: false }),
    plugin('ReadOnly.esp', 'ReadOnlyMod', 7, { isImmutable: true }),
    plugin('Other.esp', 'OtherMod', 9),
  ];

  // plugins.md, Menus and keys, story 4: an untracked plugin is no copy destination.
  it('offers the tracked, editable plugins, each with its load position', () => {
    expect(copyDestinationItems(plugins, 'New', [npc]).map(({ label, description }) => ({ label, description }))).toEqual([
      { label: 'Source.esp', description: '[3]' },
      { label: 'Patch.esp', description: '[5]' },
      { label: 'Other.esp', description: '[9]' },
    ]);
  });

  it('carries each plugin as (name, origin)', () => {
    expect(copyDestinationItems(plugins, 'New', [npc]).map((item) => item.plugin)).toContainEqual({ name: 'Patch.esp', origin: 'PatchMod' });
  });

  it('does not offer an override the plugin every record already lives in', () => {
    expect(copyDestinationItems(plugins, 'Override', [npc, faction]).map((item) => item.label)).toEqual(['Patch.esp', 'Other.esp']);
  });

  it('knows the plugin every record lives in whatever the case of its origin', () => {
    const shouted = { ...npc, origin: 'SOURCEMOD' };
    expect(copyDestinationItems(plugins, 'Override', [shouted]).map((item) => item.label)).toEqual(['Patch.esp', 'Other.esp']);
  });

  it('offers every tracked, editable plugin to an override of records from several plugins', () => {
    expect(copyDestinationItems(plugins, 'Override', [npc, elsewhere]).map((item) => item.label))
      .toEqual(['Source.esp', 'Patch.esp', 'Other.esp']);
  });
});

describe('heldCopies', () => {
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };
  const other = { name: 'Other.esp', origin: 'OtherMod' };

  it('names each record and picked destination that already holds a copy of it', () => {
    const holders = new Map([[npc.formKey, [{ name: 'Source.esp', origin: 'SourceMod' }, patch]], [faction.formKey, [other]]]);

    expect(heldCopies([npc, faction], [patch, other], holders)).toEqual([
      { record: npc, destination: patch },
      { record: faction, destination: other },
    ]);
  });

  it('matches a destination by its origin as well as its name', () => {
    const holders = new Map([[npc.formKey, [{ name: 'Patch.esp', origin: 'SomeOtherMod' }]]]);

    expect(heldCopies([npc], [patch], holders)).toEqual([]);
  });

  // As pluginAddressKey and mEdit compare them.
  it('matches a destination by name and origin whatever their case', () => {
    const holders = new Map([[npc.formKey, [{ name: 'PATCH.ESP', origin: 'patchmod' }]]]);

    expect(heldCopies([npc], [patch], holders)).toEqual([{ record: npc, destination: patch }]);
  });

  // plugins.md, Pickers, Copy: a record's own plugin holds the record, not a copy of it.
  it('leaves out a record\'s own plugin, which holds no copy to replace', () => {
    const own = { name: 'Source.esp', origin: 'SourceMod' };
    const holders = new Map([[npc.formKey, [own]], [elsewhere.formKey, [own]]]);

    expect(heldCopies([npc, elsewhere], [own], holders)).toEqual([{ record: elsewhere, destination: own }]);
  });
});

// commands.md, Doing nothing is not an error: it writes nothing and says nothing.
describe('copiesWritten', () => {
  const own = { name: 'Source.esp', origin: 'SourceMod' };
  const patch = { name: 'Patch.esp', origin: 'PatchMod' };

  it('leaves out an override into the record\'s own plugin, which wrote nothing', () => {
    expect(copiesWritten([{ record: npc, destination: own }, { record: npc, destination: patch }], 'Override'))
      .toEqual([{ record: npc, destination: patch }]);
  });

  it('keeps a copy as new into the record\'s own plugin, which is a duplicate beside it', () => {
    expect(copiesWritten([{ record: npc, destination: own }], 'New')).toEqual([{ record: npc, destination: own }]);
  });
});
