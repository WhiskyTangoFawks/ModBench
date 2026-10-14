import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { OVERWRITE_ORIGIN } from '../../instanceAdapter/instanceAdapter';
import { pluginsCommandsWith } from '../../test/pluginsCommandsWith';
import { fakeInstanceAdapter, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { PluginAddress } from '../../wire/pluginAddress';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };
const CHILD = { name: 'Child.esp', origin: 'ChildMod' };
const OTHER = { name: 'Other.esp', origin: 'OtherMod' };

const CHANGES = { treeName: 'Tracked Patch Mod.esp', moves: [{ from: '/m/plugin-source/Tracked Patch Mod.esp', to: '/m/plugin-source/Renamed Patch.esp' }], deletions: [], documents: [] };

describe('renamePlugin — the plugin source first, then the file and its lines', () => {
  let client: InMemoryMEditClient;
  let applied: unknown[];
  let failure: string | undefined;
  const apply = vi.fn((changes: unknown) => {
    applied.push(changes);
    return Promise.resolve(failure);
  });
  const rename = (newName: string, plugin: PluginAddress = PLUGIN, answers: InstanceAnswers = {}) => {
    const fake = fakeInstanceAdapter(undefined, answers);
    const result = pluginsCommandsWith(fake.adapter, client).renamePlugin({ apply }, plugin, newName, 'Fallout4');
    return { fake, result };
  };

  beforeEach(() => {
    client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', CHANGES);
    client.setCommandResult('moveLastWritten', { moved: true });
    applied = [];
    failure = undefined;
    apply.mockClear();
  });

  it('applies the source changes, moves what was last written, then hands the adapter the rename of the file and its line', async () => {
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: true });

    expect(client.calls).toEqual([
      { method: 'getRenameSourceChanges', args: [PLUGIN, 'Renamed Patch.esp'] },
      { method: 'moveLastWritten', args: [PLUGIN, 'Tracked Patch Mod.esp', 'Renamed Patch.esp'] },
    ]);
    expect(applied).toEqual([CHANGES]);
    expect(fake.calls).toEqual([
      { verb: 'renamePlugin', origin: { kind: 'mod', name: 'Tracked Patch Mod' }, from: 'Tracked Patch Mod.esp', to: 'Renamed Patch.esp', gameRelease: 'Fallout4' },
    ]);
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const { fake, result } = rename('Ran.esp', { name: 'Run.esp', origin: OVERWRITE_ORIGIN });

    await result;

    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'runtimeOutput' }, from: 'Run.esp', to: 'Ran.esp', gameRelease: 'Fallout4' }]);
  });

  it('applies nothing and renames nothing when mEdit refuses the changes, and carries the refusal', async () => {
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, sourceRenamed: false, refusal: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('moves nothing and renames no file when VS Code does not apply the changes, and carries why', async () => {
    failure = 'EEXIST';
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: false, reported: 'EEXIST' });
    expect(client.calls.map((call) => call.method)).toEqual(['getRenameSourceChanges']);
    expect(fake.calls).toEqual([]);
  });

  it('renames no file when what was last written could not move, and reports the source renamed', async () => {
    client.setCommandResult('moveLastWritten', { refused: true, message: 'git refused' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: false, sourceRenamed: true, refusal: 'git refused' });
    expect(fake.calls).toEqual([]);
  });

  it('reports the source renamed when the adapter refuses the rename of the files after it', async () => {
    const { result } = rename('Renamed Patch.esp', PLUGIN, { refusals: refusing('renamePlugin', 'disk full') });

    expect(await result).toEqual({ applied: false, sourceRenamed: true, refusal: 'disk full' });
  });
});

describe('confirmRename — what is known before any write', () => {
  let client: InMemoryMEditClient;
  const confirm = (ask: ReturnType<typeof scriptedDialog>, plugin = PLUGIN) =>
    pluginsCommandsWith(fakeInstanceAdapter().adapter, client).confirmRename(ask, plugin, 'Renamed Patch.esp');
  const dependants = (dependantPlugins: PluginAddress[], unreadable: PluginAddress[] = []) =>
    client.setQueryAnswer('getPluginDependants', { dependants: dependantPlugins, unreadable });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    dependants([]);
  });

  it('asks nothing when no plugin lists it as a master', async () => {
    const ask = scriptedDialog();

    expect(await confirm(ask)).toEqual({ confirmed: true });
    expect(ask.asked).toEqual([]);
  });

  it('asks once, naming each dependant and what follows, and confirms on the button', async () => {
    dependants([CHILD, OTHER]);
    const ask = scriptedDialog('Rename');

    expect(await confirm(ask)).toEqual({ confirmed: true });

    expect(ask.asked).toHaveLength(1);
    const question = present(ask.asked[0], 'the one recorded question');
    expect(question.message).toContain('Tracked Patch Mod.esp');
    expect(question.buttons).toEqual(['Rename']);
    expect(question.detail).toContain('Child.esp (ChildMod)');
    expect(question.detail).toContain('Other.esp (OtherMod)');
    expect(question.detail).toMatch(/old name/);
    expect(question.detail).toMatch(/Master issues/);
  });

  it('also names a plugin whose masters could not be read, as possibly keeping the old name', async () => {
    dependants([], [OTHER]);
    const ask = scriptedDialog('Rename');

    await confirm(ask);

    const detail = present(ask.asked[0], 'the one recorded question').detail;
    expect(detail).toContain('Other.esp (OtherMod)');
    expect(detail).toMatch(/could not read/);
  });

  it('confirms nothing when the question is declined, and says nothing', async () => {
    dependants([CHILD]);

    expect(await confirm(scriptedDialog(undefined))).toEqual({ confirmed: false });
  });

  it('refuses, asking nothing, when mEdit cannot say who depends on the plugin', async () => {
    client.setQueryFailure('getPluginDependants', { failed: 'refused', refusal: 'mEdit has not finished indexing the plugins.' });
    const ask = scriptedDialog('Rename');

    expect(await confirm(ask)).toEqual({ confirmed: false, refusal: 'mEdit has not finished indexing the plugins.' });
    expect(ask.asked).toEqual([]);
  });
});
