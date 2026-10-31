import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIn } from '../../manifestAdapter/manifestAdapter';
import { manifestedIn } from '../../test/modStatusFixture';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { OVERWRITE_ORIGIN } from '../../wire/pluginAddress';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, modFoldersIn, pluginFilesHeld, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import type { PluginAddress } from '../../wire/pluginAddress';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Patch Mod.esp', origin: 'Patch Mod' };

const CHANGES = { treeName: 'Patch Mod.esp', moves: [{ from: '/m/plugin-source/Patch Mod.esp', to: '/m/plugin-source/Renamed Patch.esp' }], deletions: [], documents: [] };

describe('renamePlugin — the plugin source first, then the file and its lines', () => {
  let client: InMemoryMEditClient;
  let applied: unknown[];
  let failure: string | undefined;
  const apply = vi.fn((changes: unknown) => {
    applied.push(changes);
    return Promise.resolve(failure);
  });
  const rename = (newName: string, plugin: PluginAddress = PLUGIN, answers: InstanceAnswers = {}, held: readonly string[] = []) => {
    const fake = fakeInstanceAdapter(readingFixture(pluginFilesHeld(
      { origin: plugin.origin === OVERWRITE_ORIGIN ? { kind: 'runtimeOutput' } : { kind: 'mod', name: plugin.origin }, name: plugin.name },
      ...held.map((name) => ({ origin: { kind: 'mod', name: plugin.origin } as const, name })),
    )), answers);
    const result = pluginCommandsWith(fake.adapter, client).renamePlugin({ apply }, plugin, newName);
    return { fake, result };
  };

  beforeEach(() => {
    client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', CHANGES);
    client.setCommandResult('moveLastWritten', { moved: true });
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
    applied = [];
    failure = undefined;
    apply.mockClear();
  });

  it('applies the source changes, moves what was last written, then hands the adapter the rename of the file and its line', async () => {
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: true });

    expect(client.calls).toEqual([
      { method: 'getCreatablePluginExtensions', args: [] },
      { method: 'getRenameSourceChanges', args: [PLUGIN, 'Renamed Patch.esp'] },
      { method: 'moveLastWritten', args: [PLUGIN, 'Patch Mod.esp', 'Renamed Patch.esp'] },
    ]);
    expect(applied).toEqual([CHANGES]);
    expect(fake.calls).toEqual([
      { verb: 'renamePlugin', origin: { kind: 'mod', name: 'Patch Mod' }, from: 'Patch Mod.esp', to: 'Renamed Patch.esp' },
    ]);
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const { fake, result } = rename('Ran.esp', { name: 'Run.esp', origin: OVERWRITE_ORIGIN });

    await result;

    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'runtimeOutput' }, from: 'Run.esp', to: 'Ran.esp' }]);
  });

  it('refuses a name the origin already holds before any write', async () => {
    const { fake, result } = rename('Renamed Patch.esp', PLUGIN, {}, ['Renamed Patch.esp']);

    expect(await result).toEqual({ applied: false, sourceRenamed: false, refusal: '"Patch Mod" already holds "Renamed Patch.esp".' });
    expect(client.calls.map((call) => call.method)).toEqual(['getCreatablePluginExtensions']);
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('refuses with the reason, writing nothing, when mEdit cannot say which extensions a plugin may take', async () => {
    client.setQueryFailure('getCreatablePluginExtensions', { failed: 'refused', refusal: 'mEdit is not ready.' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, sourceRenamed: false, refusal: 'Could not check "Renamed Patch.esp" for "Patch Mod.esp" (Patch Mod).', detail: 'mEdit is not ready.',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('applies nothing and renames nothing when mEdit refuses the changes, and carries the refusal', async () => {
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename the source of "Patch Mod.esp" — NotCompiledPlugin' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, sourceRenamed: false, refusal: 'Could not rename the source of "Patch Mod.esp" — NotCompiledPlugin',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('moves nothing and renames no file when VS Code does not apply the changes, and carries why', async () => {
    failure = 'EEXIST';
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: false, reported: 'EEXIST' });
    expect(client.calls.map((call) => call.method)).toEqual(['getCreatablePluginExtensions', 'getRenameSourceChanges']);
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

describe('renamePlugin — the manifest of a mod that holds the plugin follows it', () => {
  let mods: string;
  beforeEach(async () => {
    mods = await mkdtemp(join(tmpdir(), 'modbench-plugin-rename-'));
  });
  afterEach(async () => {
    await rm(mods, { recursive: true, force: true });
  });

  it('names the renamed plugin where it named the old one, so plugin sync finds no plugin not restored', async () => {
    await manifestedIn(join(mods, PLUGIN.origin), [
      { path: 'Patch Mod.esp', entry: { kind: 'held' }, hash: 'H' }, { path: 'textures/a.dds', entry: { kind: 'held' } },
    ]);
    const client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', CHANGES);
    client.setCommandResult('moveLastWritten', { moved: true });
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
    const fake = fakeInstanceAdapter(readingFixture({
      ...pluginFilesHeld({ origin: { kind: 'mod', name: PLUGIN.origin }, name: PLUGIN.name }), modFolders: modFoldersIn(mods, PLUGIN.origin),
    }));

    await pluginCommandsWith(fake.adapter, client).renamePlugin({ apply: () => Promise.resolve(undefined) }, PLUGIN, 'Renamed Patch.esp');

    const read = await manifestIn(join(mods, PLUGIN.origin));
    expect(read !== undefined && 'manifest' in read ? read.manifest.files : read).toEqual([
      { path: 'Renamed Patch.esp', entry: { kind: 'heldAt', path: 'Patch Mod.esp' }, hash: 'H' }, { path: 'textures/a.dds', entry: { kind: 'held' } },
    ]);
  });
});

describe('renameRefusal — what the prompt is told before the rename is asked for', () => {
  const refusal = (newName: string, heldIn: string) => pluginCommandsWith(fakeInstanceAdapter(readingFixture(pluginFilesHeld(
    { origin: { kind: 'mod', name: heldIn }, name: 'Renamed Patch.esp' },
  ))).adapter).renameRefusal(PLUGIN, newName, ['.esm', '.esl', '.esp']);

  it.each<[string, string, string, string | undefined]>([
    ['refuses a name the plugin\'s origin holds', 'Renamed Patch.esp', 'Patch Mod', '"Patch Mod" already holds "Renamed Patch.esp".'],
    ['lets through a name only another origin holds', 'Renamed Patch.esp', 'OtherMod', undefined],
  ])('%s', async (_case, newName, heldIn, expected) => {
    expect(await refusal(newName, heldIn)).toBe(expected);
  });
});
