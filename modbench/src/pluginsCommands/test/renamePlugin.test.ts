import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { confirmRename, renamePlugin } from '../renamePlugin';
import { OVERWRITE_ORIGIN } from '../../instanceAdapter/instanceAdapter';
import { accessTo, readPluginLines } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { PluginAddress } from '../../wire/pluginAddress';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };
const CHILD = { name: 'Child.esp', origin: 'ChildMod' };
const OTHER = { name: 'Other.esp', origin: 'OtherMod' };

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

  it('writes nothing, the source included, when the files would refuse', async () => {
    const before = await snapshotTree(root);

    const result = await rename('Renamed Patch.esp', { ...PLUGIN, name: 'Missing.esp' });

    expect(result).toMatchObject({ applied: false, sourceRenamed: false });
    expect('refusal' in result && result.refusal).toContain('Missing.esp');
    expect(client.calls).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('reports the source renamed when the write of the files fails after it', async () => {
    const adapter = accessTo(root).adapter;
    vi.spyOn(adapter, 'renamePlugin').mockRejectedValue(new Error('disk full'));

    const result = await renamePlugin({ adapter, client }, PLUGIN, 'Renamed Patch.esp', 'Fallout4');

    expect(result).toEqual({ applied: false, sourceRenamed: true, refusal: 'disk full' });
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const adapter = accessTo(root).adapter;
    const checkOnAdapter = vi.spyOn(adapter, 'checkPluginRename').mockResolvedValue({ applied: true });
    const renamePluginOnAdapter = vi.spyOn(adapter, 'renamePlugin').mockResolvedValue();

    await renamePlugin({ adapter, client }, { name: 'Run.esp', origin: OVERWRITE_ORIGIN }, 'Ran.esp', 'Fallout4');

    expect(checkOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
    expect(renamePluginOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
  });
});

describe('confirmRename — what is known before any write', () => {
  let root: string;
  let client: InMemoryMEditClient;
  const confirm = (ask: ReturnType<typeof scriptedDialog>, plugin = PLUGIN) =>
    confirmRename({ adapter: accessTo(root).adapter, client, ask }, plugin, 'Renamed Patch.esp', 'Fallout4');
  const dependants = (dependantPlugins: PluginAddress[], unreadable: PluginAddress[] = []) =>
    client.setQueryAnswer('getPluginDependants', { dependants: dependantPlugins, unreadable });

  beforeEach(() => {
    root = cloneCorpusFixture();
    client = new InMemoryMEditClient();
    dependants([]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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

  it('refuses, asking nothing, when the files would refuse', async () => {
    dependants([CHILD]);
    const ask = scriptedDialog('Rename');

    const result = await confirm(ask, { ...PLUGIN, name: 'Missing.esp' });

    expect(result).toMatchObject({ confirmed: false });
    expect('refusal' in result && result.refusal).toContain('Missing.esp');
    expect(ask.asked).toEqual([]);
  });

  it('refuses, asking nothing, when mEdit cannot say who depends on the plugin', async () => {
    client.setQueryFailure('getPluginDependants', new Error('mEdit has not finished indexing the plugins.'));
    const ask = scriptedDialog('Rename');

    expect(await confirm(ask)).toEqual({ confirmed: false, refusal: 'mEdit has not finished indexing the plugins.' });
    expect(ask.asked).toEqual([]);
  });
});
