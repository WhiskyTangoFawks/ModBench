import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
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
      { origin: { kind: 'mod', name: plugin.origin }, name: plugin.name },
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

  it('refuses a name the origin already holds before any write', async () => {
    const { fake, result } = rename('Renamed Patch.esp', PLUGIN, {}, ['Renamed Patch.esp']);

    expect(await result).toEqual({ applied: false, refusal: '"Patch Mod" already holds "Renamed Patch.esp".' });
    expect(client.calls.map((call) => call.method)).toEqual(['getCreatablePluginExtensions']);
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('refuses a name that is not a folder name before the source moves', async () => {
    const { fake, result } = rename('a/b.esp');

    expect(await result).toEqual({ applied: false, refusal: 'A name cannot be . or .. or contain / or \\' });
    expect(client.calls.map((call) => call.method)).toEqual(['getCreatablePluginExtensions']);
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('refuses with the reason, writing nothing, when mEdit cannot say which extensions a plugin may take', async () => {
    client.setQueryFailure('getCreatablePluginExtensions', { failed: 'refused', refusal: 'mEdit is not ready.' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, refusal: 'Could not check "Renamed Patch.esp" for "Patch Mod.esp" (Patch Mod).', detail: 'mEdit is not ready.',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('applies nothing and renames nothing when mEdit refuses the changes, and carries the refusal', async () => {
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename the source of "Patch Mod.esp" — NotCompiledPlugin' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, refusal: 'Could not rename the source of "Patch Mod.esp" — NotCompiledPlugin',
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

  it('reports no source renamed when a plugin with no plugin source has its files refused', async () => {
    client.setCommandResult('getRenameSourceChanges', { ...CHANGES, moves: [] });
    const { result } = rename('Renamed Patch.esp', PLUGIN, { refusals: refusing('renamePlugin', 'disk full') });

    expect(await result).toEqual({ applied: false, sourceRenamed: false, refusal: 'disk full' });
  });

  it('reports the source renamed when the adapter refuses the rename of the files after it', async () => {
    const { result } = rename('Renamed Patch.esp', PLUGIN, { refusals: refusing('renamePlugin', 'disk full') });

    expect(await result).toEqual({ applied: false, sourceRenamed: true, refusal: 'disk full' });
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
