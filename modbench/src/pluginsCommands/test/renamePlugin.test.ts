import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { renamePlugin } from '../renamePlugin';
import { OVERWRITE_ORIGIN } from '../../instanceAdapter/instanceAdapter';
import { accessTo, readPluginLines } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import type { AskQuestion } from '../../ports/dialog';
import type { PluginAddress } from '../../wire/pluginAddress';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };

describe('renamePlugin — the plugin source first, then the file and its lines', () => {
  let root: string;
  let client: InMemoryMEditClient;
  const ask = vi.fn<AskQuestion>();
  const rename = (newName: string, plugin = PLUGIN) => renamePlugin({ ...accessTo(root), client, ask }, plugin, newName, 'Fallout4');
  const dependants = (...plugins: PluginAddress[]) =>
    client.setQueryAnswer('getPluginDependants', { dependants: plugins, unreadable: [] });

  beforeEach(() => {
    root = cloneCorpusFixture();
    client = new InMemoryMEditClient();
    client.setCommandResult('renameSource', { renamed: true });
    dependants();
    ask.mockReset().mockResolvedValue('Rename');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('renames the source through the client, then the file and its line in place', async () => {
    expect(await rename('Renamed Patch.esp')).toEqual({ applied: true });

    expect(client.calls.map((call) => call.method)).toEqual(['getPluginDependants', 'renameSource']);
    expect(client.calls[1]?.args).toEqual([PLUGIN, 'Renamed Patch.esp']);
    expect(ask).not.toHaveBeenCalled();
    expect((await readPluginLines(root)).map((line) => line.name)).toContain('Renamed Patch.esp');
    expect((await snapshotTree(root)).has('mods/Tracked Patch Mod/Renamed Patch.esp')).toBe(true);
  });

  it('writes nothing when the source is refused, and carries the refusal', async () => {
    client.setCommandResult('renameSource', { refused: true, message: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked' });
    const before = await snapshotTree(root);

    expect(await rename('Renamed Patch.esp')).toEqual({
      applied: false, sourceRenamed: false, refusal: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked',
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('refuses before the source moves when the files would refuse, and writes nothing', async () => {
    const before = await snapshotTree(root);

    const result = await rename('Renamed Patch.esp', { ...PLUGIN, name: 'Missing.esp' });

    expect(result).toMatchObject({ applied: false, sourceRenamed: false });
    expect('refusal' in result && result.refusal).toContain('Missing.esp');
    expect(client.calls.map((call) => call.method)).not.toContain('renameSource');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('reports the source renamed when the write of the files fails after it', async () => {
    const adapter = accessTo(root).adapter;
    vi.spyOn(adapter, 'renamePlugin').mockRejectedValue(new Error('disk full'));

    const result = await renamePlugin({ adapter, client, ask }, PLUGIN, 'Renamed Patch.esp', 'Fallout4');

    expect(result).toEqual({ applied: false, sourceRenamed: true, refusal: 'disk full' });
  });

  describe('when plugins list it as a master', () => {
    const CHILD = { name: 'Child.esp', origin: 'ChildMod' };
    const OTHER = { name: 'Other.esp', origin: 'OtherMod' };

    it('asks once, naming each dependant and what follows, and renames on confirm', async () => {
      dependants(CHILD, OTHER);

      expect(await rename('Renamed Patch.esp')).toEqual({ applied: true });

      expect(ask).toHaveBeenCalledTimes(1);
      const [message, options] = ask.mock.calls[0] ?? [];
      expect(message).toContain('Tracked Patch Mod.esp');
      expect(options?.detail).toContain('Child.esp (ChildMod)');
      expect(options?.detail).toContain('Other.esp (OtherMod)');
      expect(`${message}${options?.detail}`).toMatch(/old name/);
      expect(`${message}${options?.detail}`).toMatch(/Master issues/);
      expect(client.calls.map((call) => call.method)).toContain('renameSource');
    });

    it('also names a plugin whose masters could not be read, as possibly keeping the old name', async () => {
      client.setQueryAnswer('getPluginDependants', { dependants: [], unreadable: [OTHER] });

      await rename('Renamed Patch.esp');

      expect(ask.mock.calls[0]?.[1].detail).toContain('Other.esp (OtherMod)');
      expect(`${ask.mock.calls[0]?.[0]}${ask.mock.calls[0]?.[1].detail}`).toMatch(/could not read/);
    });

    it('renames nothing when the question is declined', async () => {
      dependants(CHILD);
      ask.mockResolvedValue(undefined);
      const before = await snapshotTree(root);

      expect(await rename('Renamed Patch.esp')).toEqual({ applied: false, declined: true });

      expect(client.calls.map((call) => call.method)).not.toContain('renameSource');
      expect(await snapshotTree(root)).toEqual(before);
    });
  });

  it('refuses before any write when mEdit cannot say who depends on the plugin', async () => {
    client.setQueryFailure('getPluginDependants', new Error('mEdit has not finished indexing the plugins.'));
    const before = await snapshotTree(root);

    expect(await rename('Renamed Patch.esp')).toEqual({
      applied: false, sourceRenamed: false, refusal: 'mEdit has not finished indexing the plugins.',
    });
    expect(client.calls.map((call) => call.method)).not.toContain('renameSource');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const adapter = accessTo(root).adapter;
    const checkOnAdapter = vi.spyOn(adapter, 'checkPluginRename').mockResolvedValue();
    const renamePluginOnAdapter = vi.spyOn(adapter, 'renamePlugin').mockResolvedValue();

    await renamePlugin({ adapter, client, ask }, { name: 'Run.esp', origin: OVERWRITE_ORIGIN }, 'Ran.esp', 'Fallout4');

    expect(checkOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
    expect(renamePluginOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
  });
});
