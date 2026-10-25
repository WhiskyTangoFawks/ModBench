import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { InstanceAdapter, ModOrderChange, PluginOrderChange } from '../instanceAdapter';
import { implementations, modOrderOf, pluginOrderOf, PROFILE, type Subject } from './adapterContract';

const MODS_AS_LISTED = ['Alpha', 'Beta (off)', '[Upper]', 'Gamma', '[Lower]', 'Delta'];
const PLUGINS_AS_LISTED = ['A.esp', 'B.esp (off)', 'C.esp'];

describe.each(implementations)('$name holds the order changes\' contract', (implementation) => {
  let subject: Subject;
  let adapter: InstanceAdapter;
  beforeEach(async () => {
    subject = await implementation.subject();
    adapter = subject.adapter;
  });
  afterEach(() => subject.dispose());

  const changeMods = (...changes: ModOrderChange[]) => adapter.changeModOrder(PROFILE, () => changes);
  const changePlugins = (...changes: PluginOrderChange[]) => adapter.changePluginOrder(PROFILE, () => changes);

  describe('mod order', () => {
    it('refuses an entry that is not listed, and writes nothing of the batch it was in', async () => {
      await expect(changeMods({ kind: 'enable', mod: 'Beta', enabled: true }, { kind: 'enable', mod: 'Nope', enabled: true }))
        .rejects.toThrow('Mod not found in modlist: Nope');
      expect(await modOrderOf(adapter)).toEqual(MODS_AS_LISTED);
    });

    it.each<[string, ModOrderChange, string]>([
      ['a mod moved that is not listed', { kind: 'moveMods', mods: ['Nope'], place: { kind: 'modOrder' }, end: 'winning' }, 'Mod not found in modlist: Nope'],
      ['a separator moved that is not listed', { kind: 'moveSeparators', separators: ['Nope'], place: { kind: 'modOrder' }, end: 'winning' }, 'Separator not found in modlist: Nope'],
      ['a move to a separator that is not listed', { kind: 'moveMods', mods: ['Alpha'], place: { kind: 'separator', name: 'Nope' }, end: 'losing' }, 'Separator not found in modlist: Nope'],
      ['a separator renamed that is not listed', { kind: 'renameSeparator', from: 'Nope', to: 'Other' }, 'Separator not found in modlist: Nope'],
      ['a separator added beside a mod that is not listed', { kind: 'addSeparator', separator: 'New', anchor: { kind: 'mod', name: 'Nope' } }, 'Mod not found in modlist: Nope'],
    ])('refuses %s', async (_, change, message) => {
      await expect(changeMods(change)).rejects.toThrow(message);
    });

    it('refuses a separator that is already listed, in any case', async () => {
      await expect(changeMods({ kind: 'addSeparator', separator: 'UPPER', anchor: { kind: 'mod', name: 'Alpha' } }))
        .rejects.toThrow('Separator already in modlist: UPPER');
      await expect(changeMods({ kind: 'renameSeparator', from: 'Upper', to: 'lower' })).rejects.toThrow('Separator already in modlist: lower');
      expect(await modOrderOf(adapter)).toEqual(MODS_AS_LISTED);
    });

    it('refuses a mod renamed to a mod that is listed', async () => {
      await expect(changeMods({ kind: 'renameMod', from: 'Alpha', to: 'gamma' })).rejects.toThrow('Mod already in modlist: gamma');
    });

    const MOVED_WHERE_IT_IS: ModOrderChange = { kind: 'moveMods', mods: ['Alpha'], place: { kind: 'modOrder' }, end: 'winning' };
    it.each<[string, ModOrderChange, ModOrderChange[]]>([
      ['an entry added that is listed', { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'alpha' } }, []],
      ['a mod dropped that is not listed', { kind: 'dropMod', mod: 'Nope' }, []],
      ['a separator dropped that is not listed', { kind: 'dropSeparator', separator: 'Nope' }, []],
      ['a mod enabled as it is', { kind: 'enable', mod: 'Alpha', enabled: true }, [{ kind: 'enable', mod: 'Alpha', enabled: true }]],
      ['a mod moved where it already is', MOVED_WHERE_IT_IS, [MOVED_WHERE_IT_IS]],
    ])('does nothing for %s, and lands only what the order lists', async (_, change, landed) => {
      const written = await changeMods(change);
      expect(written).toEqual({ wrote: false, landed });
      expect(await modOrderOf(adapter)).toEqual(MODS_AS_LISTED);
    });

    it('names each entry as listed, not as given', async () => {
      const written = await changeMods(
        { kind: 'enable', mod: 'bETA', enabled: true },
        { kind: 'moveMods', mods: ['gamma'], place: { kind: 'separator', name: 'UPPER' }, end: 'winning' },
        { kind: 'dropMod', mod: 'DELTA' },
      );
      expect(written).toEqual({
        wrote: true,
        landed: [
          { kind: 'enable', mod: 'Beta', enabled: true },
          { kind: 'moveMods', mods: ['Gamma'], place: { kind: 'separator', name: 'Upper' }, end: 'winning' },
          { kind: 'dropMod', mod: 'Delta' },
        ],
      });
    });

    it('omits from what landed a change that was already done', async () => {
      const written = await changeMods({ kind: 'dropMod', mod: 'Nope' }, { kind: 'enable', mod: 'Beta', enabled: true });
      expect(written).toEqual({ wrote: true, landed: [{ kind: 'enable', mod: 'Beta', enabled: true }] });
    });

    it.each<[string, ModOrderChange, string[]]>([
      ['enabling', { kind: 'enable', mod: 'Beta', enabled: true }, ['Alpha', 'Beta', '[Upper]', 'Gamma', '[Lower]', 'Delta']],
      ['moving mods to the losing end of a separator', { kind: 'moveMods', mods: ['Alpha'], place: { kind: 'separator', name: 'Lower' }, end: 'losing' }, ['Beta (off)', '[Upper]', 'Gamma', 'Alpha', '[Lower]', 'Delta']],
      ['moving mods to the winning end of the ungrouped mods', { kind: 'moveMods', mods: ['Gamma'], place: { kind: 'ungrouped' }, end: 'winning' }, ['Alpha', 'Beta (off)', '[Upper]', '[Lower]', 'Gamma', 'Delta']],
      ['moving mods beside a mod', { kind: 'moveMods', mods: ['Delta', 'Alpha'], place: { kind: 'mod', name: 'Gamma' }, end: 'losing' }, ['Beta (off)', '[Upper]', 'Gamma', 'Alpha', 'Delta', '[Lower]']],
      ['moving a separator and its mods to the losing end', { kind: 'moveSeparators', separators: ['Upper'], place: { kind: 'modOrder' }, end: 'losing' }, ['Gamma', '[Lower]', 'Alpha', 'Beta (off)', '[Upper]', 'Delta']],
      ['adding an entry at the winning end', { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'New' } }, ['New (off)', ...MODS_AS_LISTED]],
      ['adding a separator after a mod', { kind: 'addSeparator', separator: 'Fresh', anchor: { kind: 'mod', name: 'Gamma' } }, ['Alpha', 'Beta (off)', '[Upper]', 'Gamma', '[Fresh]', '[Lower]', 'Delta']],
      ['renaming a mod', { kind: 'renameMod', from: 'Delta', to: 'Omega' }, ['Alpha', 'Beta (off)', '[Upper]', 'Gamma', '[Lower]', 'Omega']],
      ['renaming a separator', { kind: 'renameSeparator', from: 'Lower', to: 'Bottom' }, ['Alpha', 'Beta (off)', '[Upper]', 'Gamma', '[Bottom]', 'Delta']],
      ['dropping a mod', { kind: 'dropMod', mod: 'Gamma' }, ['Alpha', 'Beta (off)', '[Upper]', '[Lower]', 'Delta']],
      ['dropping a separator', { kind: 'dropSeparator', separator: 'Upper' }, ['Alpha', 'Beta (off)', 'Gamma', '[Lower]', 'Delta']],
    ])('shows %s to the next read of the order', async (_, change, order) => {
      const written = await changeMods(change);
      expect(written.wrote).toBe(true);
      expect(await modOrderOf(adapter)).toEqual(order);
    });
  });

  describe('profile', () => {
    it('shows the profile it selected to the next read, and writes nothing for the one selected', async () => {
      expect(await adapter.selectProfile('Default')).toEqual({ wrote: false });
      expect(await adapter.selectProfile('Other')).toEqual({ wrote: true });
      expect((await adapter.reading()).profile).toBe('Other');
    });
  });

  describe('plugin order', () => {
    it('refuses a plugin that is not listed, and writes nothing of the batch it was in', async () => {
      await expect(changePlugins({ kind: 'enable', plugin: 'B.esp', enabled: true }, { kind: 'drop', plugin: 'Nope.esp' }))
        .rejects.toThrow('Plugin not found in plugins.txt: Nope.esp');
      expect(await pluginOrderOf(adapter)).toEqual(PLUGINS_AS_LISTED);
    });

    it.each<[string, PluginOrderChange]>([
      ['enabling', { kind: 'enable', plugin: 'Nope.esp', enabled: true }],
      ['moving', { kind: 'move', plugins: ['Nope.esp'], toIndex: 0 }],
    ])('refuses %s a plugin that is not listed', async (_, change) => {
      await expect(changePlugins(change)).rejects.toThrow('Plugin not found in plugins.txt: Nope.esp');
    });

    it.each<[string, PluginOrderChange]>([
      ['a plugin added that is listed', { kind: 'add', plugin: 'a.ESP' }],
      ['a plugin enabled as it is', { kind: 'enable', plugin: 'A.esp', enabled: true }],
      ['a plugin moved where it already is', { kind: 'move', plugins: ['A.esp'], toIndex: 0 }],
    ])('does nothing for %s', async (_, change) => {
      expect((await changePlugins(change)).wrote).toBe(false);
      expect(await pluginOrderOf(adapter)).toEqual(PLUGINS_AS_LISTED);
    });

    it.each<[string, PluginOrderChange, string[]]>([
      ['enabling, a plugin named in another case', { kind: 'enable', plugin: 'b.ESP', enabled: true }, ['A.esp', 'B.esp', 'C.esp']],
      ['moving', { kind: 'move', plugins: ['C.esp', 'A.esp'], toIndex: 1 }, ['B.esp (off)', 'A.esp', 'C.esp']],
      ['moving, a plugin named in another case', { kind: 'move', plugins: ['c.ESP'], toIndex: 0 }, ['C.esp', 'A.esp', 'B.esp (off)']],
      ['adding', { kind: 'add', plugin: 'New.esp' }, [...PLUGINS_AS_LISTED, 'New.esp (off)']],
      ['dropping', { kind: 'drop', plugin: 'b.esp' }, ['A.esp', 'C.esp']],
    ])('shows %s to the next read of the order', async (_, change, order) => {
      expect((await changePlugins(change)).wrote).toBe(true);
      expect(await pluginOrderOf(adapter)).toEqual(order);
    });
  });
});
