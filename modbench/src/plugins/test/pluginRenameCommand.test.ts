import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { clientHoldingNothing, pluginsOver } from './pluginsOver';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import type { SourceEditing } from '../../textDocuments/sourceEditing';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';

const held = (name: string, origin: string) => ({ name, origin: { kind: 'mod', name: origin } }) as const;

const PLUGIN = { name: 'Patch.esp', origin: 'ModA' };
const CHANGES = { treeName: 'Patch.esp', moves: [{ from: '/m/plugin-source/Patch.esp', to: '/m/plugin-source/Renamed.esp' }], deletions: [], documents: [], leftBehind: [] };
const NO_CHANGES = { moves: [], deletions: [], documents: [] };
const MOVED = '/m/plugin-source/Patch.esp moved to /m/plugin-source/Renamed.esp.';
const RENAMED = [{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'ModA' }, from: 'Patch.esp', to: 'Renamed.esp' }];

async function renaming() {
  const client = clientHoldingNothing();
  client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
  client.setCommandResult('getRenameSourceChanges', CHANGES);
  client.setCommandResult('moveLastWritten', { moved: true });
  client.setQueryAnswer('getPluginNameReferences', []);
  const instanceAnswers: InstanceAnswers = {};
  const fake = fakeInstanceAdapter(readingFixture({
    ...pluginFilesHeld(held('Patch.esp', 'ModA'), held('Taken.esp', 'ModA')), mods: [{ kind: 'mod', name: 'ModA', enabled: true }],
  }), instanceAnswers);
  const apply = vi.fn<SourceEditing['applyWorkspaceChanges']>().mockResolvedValue();
  const queue = oneAtATime();
  const queued = vi.fn();
  const refreshSourceControlFor = vi.fn();
  const made = pluginsOver({
    client, commandsClient: client, adapter: fake.adapter,
    value: instanceValueFixture({
      plugins: [{ name: 'Patch.esp', origin: 'ModA', path: '/m/Patch.esp', line: 0, enabled: true, winning: true }],
      pluginsLoadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'Data/', path: '/game/Data/Fallout4.esm' }],
    }),
    sourceEditing: { applyWorkspaceChanges: apply, oneAtATime: (job) => { queued(); return queue(job); }, refreshSourceControlFor },
  });
  const row = await made.pluginRows();
  const run = (...args: unknown[]) => host.run('modbench.plugin.rename', ...args);
  const validate = async (value: string): Promise<string | undefined> => {
    let validated: string | undefined;
    host.types(async (options) => { validated = await options.validateInput?.(value) ?? undefined; return undefined; });
    await run(row('Patch.esp'));
    return validated;
  };
  const asked = (method: string) => client.calls.filter((call) => call.method === method);
  return {
    client, fake, instanceAnswers, apply, queued, refreshSourceControlFor, run, validate, asked, row,
    reporter: made.reporter('plugin.rename'), select: (rows: readonly unknown[]) => { made.view().selectRows(rows); },
  };
}

describe('modbench.plugin.rename', () => {
  it('asks with the current name filled in, then renames the source and the file, under the Plugins bar', async () => {
    const { fake, reporter, run, asked, row } = await renaming();
    host.types(() => 'Renamed.esp');

    await run(row('Patch.esp'));

    expect(host.inputsAsked.map(({ value }) => value)).toEqual(['Patch.esp']);
    expect(asked('getRenameSourceChanges').map(({ args }) => args.slice(0, 2))).toEqual([[PLUGIN, 'Renamed.esp']]);
    expect(fake.calls).toEqual(RENAMED);
    expect(host.progress).toEqual(['opens on modbench.pluginListTree', 'closes']);
    expect(reporter.reports).toEqual([]);
  });

  it('renames the plugin to the name an entry point supplies, as Rename Symbol does, prompting nothing', async () => {
    const { fake, run } = await renaming();

    await run(undefined, undefined, { plugin: PLUGIN, name: 'Renamed.esp' });

    expect(host.inputsAsked).toEqual([]);
    expect(fake.calls).toEqual(RENAMED);
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Patch.esp']])('renames nothing on %s', async (_, answer) => {
    const { fake, run, asked, row } = await renaming();
    host.types(() => answer);

    await run(row('Patch.esp'));

    expect(asked('getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(host.progress).toEqual([]);
  });

  it('takes nothing from a row that is no plugin line', async () => {
    const { run, asked, row } = await renaming();

    await run(row('Fallout4.esm', 'Data/'));

    expect(host.inputsAsked).toEqual([]);
    expect([asked('getCreatablePluginExtensions'), asked('getRenameSourceChanges')]).toEqual([[], []]);
  });

  describe('the prompt refuses what Create plugin refuses, compared without case', () => {
    it('lets the empty name and the same name through to renaming nothing', async () => {
      const { validate } = await renaming();
      expect(await validate('')).toBeUndefined();
      expect(await validate('Patch.esp')).toBeUndefined();
    });

    it('refuses a name the plugin\'s own place holds', async () => {
      const { validate } = await renaming();
      expect(await validate('Taken.esp')).toBe('"ModA" already holds "Taken.esp".');
    });

    it('refuses by the extensions mEdit allows now', async () => {
      const { validate, client } = await renaming();
      client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esp']);
      expect(await validate('Patch.esl')).toBe('Extension must be .esm or .esp');
    });

    it('shows why when the name cannot be checked, rather than rejecting', async () => {
      const { validate, fake } = await renaming();
      vi.spyOn(fake.adapter, 'originHoldsFile').mockRejectedValue(new Error('EACCES'));
      expect(await validate('Other.esp')).toBe('Could not check "Other.esp": EACCES');
    });
  });

  it('applies the changes as one workspace edit one at a time, and refreshes Source Control for the plugin', async () => {
    const { apply, queued, refreshSourceControlFor, run, row } = await renaming();
    host.types(() => 'Renamed.esp');

    await run(row('Patch.esp'));

    expect(queued).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith([{ moves: CHANGES.moves, deletions: [], documents: [] }, NO_CHANGES, NO_CHANGES]);
    expect(refreshSourceControlFor).toHaveBeenCalledWith(PLUGIN);
  });

  it('names the rename and the plugin when VS Code cannot apply the changes, writing no file', async () => {
    const { fake, reporter, apply, run, asked, row } = await renaming();
    host.types(() => 'Renamed.esp');
    apply.mockRejectedValueOnce(new Error('EEXIST'));

    await run(row('Patch.esp'));

    expect(reporter.reports).toMatchObject([{
      severity: 'error',
      message: 'Could not rename "Patch.esp" (ModA): its references may be partly changed, and its files and folders partly moved.',
    }]);
    expect(asked('moveLastWritten')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('lands, warning with each reference that could not follow', async () => {
    const { client, fake, reporter, run, row } = await renaming();
    host.types(() => 'Renamed.esp');
    client.setQueryAnswer('getPluginNameReferences', [{ formKey: '000000:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' }, inPluginSource: false }]);

    await run(row('Patch.esp'));

    expect(fake.calls).toEqual(RENAMED);
    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Renamed "Patch.esp" (ModA) to "Renamed.esp". 1 references to it could not follow.',
      detail: '000000:Other.esp in Other.esp (ModB)',
    }]);
  });

  it('tells a refused source, writing no file', async () => {
    const { client, fake, reporter, run, row } = await renaming();
    host.types(() => 'Renamed.esp');
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename "Patch.esp" — NotCompiledPlugin' });

    await run(row('Patch.esp'));

    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rename "Patch.esp" — NotCompiledPlugin', detail: undefined },
    ]);
  });

  it('names the plugin when the file and lines of a plugin with no plugin source failed', async () => {
    const { client, instanceAnswers, reporter, run, row } = await renaming();
    host.types(() => 'Renamed.esp');
    client.setCommandResult('getRenameSourceChanges', { ...CHANGES, moves: [] });
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    await run(row('Patch.esp'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not rename "Patch.esp" (ModA): its file and lines were not renamed.', detail: 'disk full' }]);
  });

  it('names the plugin and says its source was renamed when the file and lines failed after it', async () => {
    const { instanceAnswers, reporter, run, row } = await renaming();
    host.types(() => 'Renamed.esp');
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    await run(row('Patch.esp'));

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: `Could not rename "Patch.esp" (ModA): its references were changed, and its file and lines were not. ${MOVED}`,
      detail: 'disk full',
    }]);
  });
});

describe('modbench.plugin.rename, called by the agent', () => {
  const calling = (name: string, plugins = [PLUGIN]) => new AgentCall(plugins.map((plugin) => ({ kind: 'plugin' as const, plugin })), { name });

  it('renames the plugin given, never the selection, prompting nothing and reporting nothing, and answers the outcome', async () => {
    const { fake, reporter, run, asked, row, select } = await renaming();
    select([row('Patch.esp')]);

    const answered = await run(calling('Renamed.esp'));

    expect(asked('getRenameSourceChanges').map(({ args }) => args.slice(0, 2))).toEqual([[PLUGIN, 'Renamed.esp']]);
    expect(fake.calls).toEqual(RENAMED);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Renamed.esp', origin: 'ModA' }], refused: [] } });
    expect(host.inputsAsked).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('answers a refused source, reporting nothing', async () => {
    const { client, reporter, run } = await renaming();
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename "Patch.esp" — NotCompiledPlugin' });

    expect(await run(calling('Renamed.esp'))).toMatchObject({ applied: false, refusal: 'Could not rename "Patch.esp" — NotCompiledPlugin' });
    expect(reporter.reports).toEqual([]);
  });

  it('answers the point where the file and lines failed, reporting nothing', async () => {
    const { instanceAnswers, reporter, run } = await renaming();
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    expect(await run(calling('Renamed.esp'))).toMatchObject({
      applied: false,
      refusal: `Could not rename "Patch.esp" (ModA): its references were changed, and its file and lines were not. ${MOVED}`,
      detail: 'disk full',
    });
    expect(reporter.reports).toEqual([]);
  });

  it('refuses a name its place holds as a refusal result, renaming nothing', async () => {
    const { fake, run, asked } = await renaming();

    expect(await run(calling('Taken.esp'))).toMatchObject({ applied: false, refusal: '"ModA" already holds "Taken.esp".' });

    expect(asked('getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses by the extensions mEdit allows now', async () => {
    const { client, run } = await renaming();
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esp']);

    expect(await run(calling('Renamed.esl'))).toMatchObject({ applied: false, refusal: 'Extension must be .esm or .esp' });
  });

  it('refuses more than one plugin, renaming nothing', async () => {
    const { fake, run, asked } = await renaming();

    await expect(run(calling('Renamed.esp', [PLUGIN, PLUGIN]))).rejects.toThrow('carries one plugin');

    expect(asked('getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an Argument that is not a plugin, renaming nothing', async () => {
    const { fake, run, asked } = await renaming();

    await expect(run(new AgentCall([{ kind: 'mod', name: 'ModA' }], { name: 'Renamed.esp' }))).rejects.toBeInstanceOf(Refusal);

    expect(asked('getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
