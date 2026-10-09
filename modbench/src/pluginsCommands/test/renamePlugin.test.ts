import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { confirmRename, renamePlugin } from '../renamePlugin';
import { OVERWRITE_ORIGIN } from '../../instanceAdapter/instanceAdapter';
import { adapterOver, readPluginLines } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture, snapshotTree } from '../../test/mo2/corpusFixture';
import { scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { PluginAddress } from '../../wire/pluginAddress';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Tracked Patch Mod.esp', origin: 'Tracked Patch Mod' };
const CHILD = { name: 'Child.esp', origin: 'ChildMod' };
const OTHER = { name: 'Other.esp', origin: 'OtherMod' };

const CHANGES = { treeName: 'Tracked Patch Mod.esp', moves: [{ from: '/m/plugin-source/Tracked Patch Mod.esp', to: '/m/plugin-source/Renamed Patch.esp' }], deletions: [], documents: [] };

describe('renamePlugin — the plugin source first, then the file and its lines', () => {
  let root: string;
  let client: InMemoryMEditClient;
  let applied: unknown[];
  let applies: boolean;
  const apply = vi.fn((changes: unknown) => {
    applied.push(changes);
    return Promise.resolve(applies);
  });
  const rename = (newName: string, plugin = PLUGIN) =>
    renamePlugin({ adapter: adapterOver(root), client, source: { apply } }, plugin, newName, 'Fallout4');

  beforeEach(() => {
    root = cloneCorpusFixture();
    client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', CHANGES);
    client.setCommandResult('moveLastWritten', { moved: true });
    applied = [];
    applies = true;
    apply.mockClear();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('applies the source changes, moves what was last written, then renames the file and its line in place', async () => {
    expect(await rename('Renamed Patch.esp')).toEqual({ applied: true });

    expect(client.calls).toEqual([
      { method: 'getRenameSourceChanges', args: [PLUGIN, 'Renamed Patch.esp'] },
      { method: 'moveLastWritten', args: [PLUGIN, 'Tracked Patch Mod.esp', 'Renamed Patch.esp'] },
    ]);
    expect(applied).toEqual([CHANGES]);
    expect((await readPluginLines(root)).map((line) => line.name)).toContain('Renamed Patch.esp');
    expect((await snapshotTree(root)).has('mods/Tracked Patch Mod/Renamed Patch.esp')).toBe(true);
  });

  it('applies nothing and writes nothing when mEdit refuses the changes, and carries the refusal', async () => {
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked' });
    const before = await snapshotTree(root);

    expect(await rename('Renamed Patch.esp')).toEqual({
      applied: false, sourceRenamed: false, refusal: 'Could not rename the source of "Tracked Patch Mod.esp" — NotTracked',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('moves nothing and renames no file when VS Code does not apply the changes, which the apply has told', async () => {
    applies = false;
    const before = await snapshotTree(root);

    expect(await rename('Renamed Patch.esp')).toEqual({ applied: false, reported: true });
    expect(client.calls.map((call) => call.method)).toEqual(['getRenameSourceChanges']);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('renames no file when what was last written could not move, and reports the source renamed', async () => {
    client.setCommandResult('moveLastWritten', { refused: true, message: 'git refused' });
    const before = await snapshotTree(root);

    expect(await rename('Renamed Patch.esp')).toEqual({ applied: false, sourceRenamed: true, refusal: 'git refused' });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('writes nothing, the source included, when the files would refuse', async () => {
    const before = await snapshotTree(root);

    const result = await rename('Renamed Patch.esp', { ...PLUGIN, name: 'Missing.esp' });

    expect(result).toMatchObject({ applied: false, sourceRenamed: false });
    expect('refusal' in result && result.refusal).toContain('Missing.esp');
    expect(client.calls).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('reports the source renamed when the write of the files fails after it', async () => {
    const adapter = adapterOver(root);
    vi.spyOn(adapter, 'renamePlugin').mockRejectedValue(new Error('disk full'));

    const result = await renamePlugin({ adapter, client, source: { apply } }, PLUGIN, 'Renamed Patch.esp', 'Fallout4');

    expect(result).toEqual({ applied: false, sourceRenamed: true, refusal: 'disk full' });
  });

  it('puts a rename of Overwrite\'s plugin to the adapter as the run-time output', async () => {
    const adapter = adapterOver(root);
    const checkOnAdapter = vi.spyOn(adapter, 'checkPluginRename').mockResolvedValue({ applied: true });
    const renamePluginOnAdapter = vi.spyOn(adapter, 'renamePlugin').mockResolvedValue();

    await renamePlugin({ adapter, client, source: { apply } }, { name: 'Run.esp', origin: OVERWRITE_ORIGIN }, 'Ran.esp', 'Fallout4');

    expect(checkOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
    expect(renamePluginOnAdapter).toHaveBeenCalledWith({ kind: 'runtimeOutput' }, 'Run.esp', 'Ran.esp', 'Fallout4');
  });
});

describe('confirmRename — what is known before any write', () => {
  let root: string;
  let client: InMemoryMEditClient;
  const confirm = (ask: ReturnType<typeof scriptedDialog>, plugin = PLUGIN) =>
    confirmRename({ adapter: adapterOver(root), client, ask }, plugin, 'Renamed Patch.esp', 'Fallout4');
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
