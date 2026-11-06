import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, showInputBox } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showInputBox: vi.fn(),
  };
});

import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand: vi.fn() },
    window: { showInputBox, withProgress: recordedWithProgress },
    workspace: { textDocuments: [] },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, Uri,
  };
});

import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import type { SourceEditing } from '../../textDocuments/sourceEditing';
import { progressSteps } from '../../test/recordedProgress';
import { registerRenamePluginCommand } from '../pluginRenameCommand';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../pluginRows';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { present } from '../../ports/present';

const held = (name: string, origin: string) => ({ name, origin: { kind: 'mod', name: origin } }) as const;

const PLUGIN = { name: 'Patch.esp', origin: 'ModA' };
const CHANGES = { treeName: 'Patch.esp', moves: [{ from: '/m/plugin-source/Patch.esp', to: '/m/plugin-source/Renamed.esp' }], deletions: [], documents: [], leftBehind: [] };
const NO_CHANGES = { moves: [], deletions: [], documents: [] };
const MOVED = '/m/plugin-source/Patch.esp moved to /m/plugin-source/Renamed.esp.';

function setup(selection: readonly PluginsTreeNode[] = []) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
  client.setCommandResult('getRenameSourceChanges', CHANGES);
  client.setCommandResult('moveLastWritten', { moved: true });
  client.setQueryAnswer('getPluginNameReferences', []);
  const instanceAnswers: InstanceAnswers = {};
  const fake = fakeInstanceAdapter(readingFixture({
    ...pluginFilesHeld(held('Patch.esp', 'ModA'), held('Taken.esp', 'ModA')), mods: [{ kind: 'mod', name: 'ModA', enabled: true }],
  }), instanceAnswers);
  const instance = {
    value: instanceValueFixture(),
    quiet: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } finally {
        progressSteps.push('Instance loader: read every file again');
      }
    },
  };
  const reporter = recordingReporter();
  const apply = vi.fn<SourceEditing['applyWorkspaceChanges']>().mockResolvedValue();
  const queue = oneAtATime();
  const queued = vi.fn();
  const source: SourceEditing = {
    applyWorkspaceChanges: apply,
    oneAtATime: (job) => { queued(); return queue(job); },
    refreshSourceControlFor: vi.fn(),
  };
  registerRenamePluginCommand({ client, commands: pluginCommandsWith(fake.adapter, client), instance, reporter, source }, () => selection);
  const run = present(handlers.get('modbench.plugin.rename'), 'the rename plugin command');
  const validate = async (value: string): Promise<string | undefined> => {
    let validated: string | undefined;
    showInputBox.mockImplementationOnce(async (options: { validateInput: (v: string) => Promise<string | undefined> | undefined }) => {
      validated = await options.validateInput(value);
      return undefined;
    });
    await run(new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin));
    return validated;
  };
  return { client, fake, instanceAnswers, reporter, source, apply, queued, run, validate };
}

const row = () => new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin);

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.plugin.rename', () => {
  it('asks with the current name filled in, then renames the source and the file, under the Plugins bar and a read after', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, fake, reporter, run } = setup();

    await run(row());

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'Patch.esp' }));
    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges').map(({ args }) => args.slice(0, 2))).toEqual([[PLUGIN, 'Renamed.esp']]);
    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'ModA' }, from: 'Patch.esp', to: 'Renamed.esp' }]);
    expect(progressSteps).toEqual(['progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes']);
    expect(reporter.reports).toEqual([]);
  });

  it('renames the plugin to the name an entry point supplies, as Rename Symbol does, prompting nothing', async () => {
    const { fake, run } = setup();

    await run(undefined, undefined, { plugin: PLUGIN, name: 'Renamed.esp' });

    expect(showInputBox).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'ModA' }, from: 'Patch.esp', to: 'Renamed.esp' }]);
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Patch.esp']])('renames nothing on %s', async (_, answer) => {
    showInputBox.mockResolvedValueOnce(answer);
    const { client, fake, run } = setup();

    await run(row());

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(progressSteps).toEqual([]);
  });

  it('takes nothing from a row that is no plugin line', async () => {
    const { client, run } = setup();

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data/'));

    expect(showInputBox).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
  });

  describe('the prompt refuses what Create plugin refuses, compared without case', () => {
    it('lets the empty name and the same name through to renaming nothing', async () => {
      const { validate } = setup();
      expect(await validate('')).toBeUndefined();
      expect(await validate('Patch.esp')).toBeUndefined();
    });

    it('refuses a name the plugin\'s own place holds', async () => {
      const { validate } = setup();
      expect(await validate('Taken.esp')).toBe('"ModA" already holds "Taken.esp".');
    });

    it('refuses by the extensions mEdit allows now', async () => {
      const { validate, client } = setup();
      client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esp']);
      expect(await validate('Patch.esl')).toBe('Extension must be .esm or .esp');
    });

    it('shows why when the name cannot be checked, rather than rejecting', async () => {
      const { validate, fake } = setup();
      vi.spyOn(fake.adapter, 'originHoldsFile').mockRejectedValue(new Error('EACCES'));
      expect(await validate('Other.esp')).toBe('Could not check "Other.esp": EACCES');
    });
  });

  it('applies the changes as one workspace edit one at a time, and refreshes Source Control for the plugin', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { source, apply, queued, run } = setup();

    await run(row());

    expect(queued).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith([{ moves: CHANGES.moves, deletions: [], documents: [] }, NO_CHANGES, NO_CHANGES]);
    expect(source.refreshSourceControlFor).toHaveBeenCalledWith(PLUGIN);
  });

  it('names the rename and the plugin when VS Code cannot apply the changes, writing no file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, fake, reporter, apply, run } = setup();
    apply.mockRejectedValueOnce(new Error('EEXIST'));

    await run(row());

    expect(reporter.reports).toMatchObject([{
      severity: 'error',
      message: 'Could not rename "Patch.esp" (ModA): its references may be partly changed, and its files and folders partly moved.',
    }]);
    expect(client.calls.filter((c) => c.method === 'moveLastWritten')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('lands, warning with each reference that could not follow', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, fake, reporter, run } = setup();
    client.setQueryAnswer('getPluginNameReferences', [{ formKey: '000000:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' }, inPluginSource: false }]);

    await run(row());

    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'ModA' }, from: 'Patch.esp', to: 'Renamed.esp' }]);
    expect(reporter.reports).toEqual([{
      severity: 'warning',
      message: 'Renamed "Patch.esp" (ModA) to "Renamed.esp". 1 references to it could not follow.',
      detail: '000000:Other.esp in Other.esp (ModB)',
    }]);
  });

  it('tells a refused source, writing no file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, fake, reporter, run } = setup();
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename "Patch.esp" — NotCompiledPlugin' });

    await run(row());

    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rename "Patch.esp" — NotCompiledPlugin', detail: undefined },
    ]);
  });

  it('names the plugin when the file and lines of a plugin with no plugin source failed', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, instanceAnswers, reporter, run } = setup();
    client.setCommandResult('getRenameSourceChanges', { ...CHANGES, moves: [] });
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    await run(row());

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not rename "Patch.esp" (ModA): its file and lines were not renamed.', detail: 'disk full' }]);
  });

  it('names the plugin and says its source was renamed when the file and lines failed after it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { instanceAnswers, reporter, run } = setup();
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    await run(row());

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
    const { client, fake, reporter, run } = setup([row()]);

    const answered = await run(calling('Renamed.esp'));

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges').map(({ args }) => args.slice(0, 2))).toEqual([[PLUGIN, 'Renamed.esp']]);
    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'ModA' }, from: 'Patch.esp', to: 'Renamed.esp' }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Renamed.esp', origin: 'ModA' }], refused: [] } });
    expect(showInputBox).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('answers a refused source, reporting nothing', async () => {
    const { client, reporter, run } = setup();
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename "Patch.esp" — NotCompiledPlugin' });

    expect(await run(calling('Renamed.esp'))).toMatchObject({ applied: false, refusal: 'Could not rename "Patch.esp" — NotCompiledPlugin' });
    expect(reporter.reports).toEqual([]);
  });

  it('answers the point where the file and lines failed, reporting nothing', async () => {
    const { instanceAnswers, reporter, run } = setup();
    instanceAnswers.refusals = refusing('renamePlugin', 'disk full');

    expect(await run(calling('Renamed.esp'))).toMatchObject({
      applied: false,
      refusal: `Could not rename "Patch.esp" (ModA): its references were changed, and its file and lines were not. ${MOVED}`,
      detail: 'disk full',
    });
    expect(reporter.reports).toEqual([]);
  });

  it('refuses a name its place holds as a refusal result, renaming nothing', async () => {
    const { client, fake, run } = setup();

    expect(await run(calling('Taken.esp'))).toMatchObject({ applied: false, refusal: '"ModA" already holds "Taken.esp".' });

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses by the extensions mEdit allows now', async () => {
    const { client, run } = setup();
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esp']);

    expect(await run(calling('Renamed.esl'))).toMatchObject({ applied: false, refusal: 'Extension must be .esm or .esp' });
  });

  it('refuses more than one plugin, renaming nothing', async () => {
    const { client, fake, run } = setup();

    await expect(run(calling('Renamed.esp', [PLUGIN, PLUGIN]))).rejects.toThrow('carries one plugin');

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an Argument that is not a plugin, renaming nothing', async () => {
    const { client, fake, run } = setup();

    await expect(run(new AgentCall([{ kind: 'mod', name: 'ModA' }], { name: 'Renamed.esp' }))).rejects.toBeInstanceOf(Refusal);

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
