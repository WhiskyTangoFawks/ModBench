import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { renamePlugin } from '../renamePlugin';
import { OVERWRITE_ORIGIN } from '../../instanceAdapter/instanceAdapter';
import { accessTo, readPluginLines } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };

describe('renamePlugin — the plugin source first, then the file and its lines', () => {
  let root: string;
  let client: InMemoryMEditClient;
  const rename = (newName: string, plugin = PLUGIN) => renamePlugin({ ...accessTo(root), client }, plugin, newName, 'Fallout4');

  beforeEach(() => {
    root = cloneCorpusFixture();
    client = new InMemoryMEditClient();
    client.setCommandResult('renameSource', { renamed: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('renames the source through the client, then the file and its line in place', async () => {
    expect(await rename('Renamed Patch.esp')).toEqual({ applied: true });

    expect(client.calls).toEqual([{ method: 'renameSource', args: [PLUGIN, 'Renamed Patch.esp'] }]);
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

  it('reports the source renamed when the files refuse after it, and changes no file', async () => {
    const before = await snapshotTree(root);

    const result = await rename('Renamed Patch.esp', { ...PLUGIN, name: 'Missing.esp' });

    expect(result).toMatchObject({ applied: false, sourceRenamed: true, refusal: expect.stringContaining('Missing.esp') });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const adapter = accessTo(root).adapter;
    const renamePluginOnAdapter = vi.spyOn(adapter, 'renamePlugin').mockResolvedValue();

    await renamePlugin({ adapter, client }, { name: 'Run.esp', origin: OVERWRITE_ORIGIN }, 'Ran.esp', 'Fallout4');

    expect(renamePluginOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
  });
});
