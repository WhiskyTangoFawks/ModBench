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
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand: vi.fn() },
    window: { showInputBox, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, Uri: { from: uriFrom },
  };
});

import { oneAtATime } from '../../drivingLib/oneAtATime';
import type { SourceEditing } from '../../drivingLib/sourceEditing';
import { progressSteps } from '../../test/recordedProgress';
import { registerRenamePluginCommand } from '../pluginRenameCommand';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { AskQuestion } from '../../ports/dialog';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';

const held = (name: string, origin: string): LoadOrderPlugin =>
  ({ name, origin, path: `/instance/mods/${origin}/${name}`, line: null, enabled: true, winning: true });

const PLUGIN = { name: 'Patch.esp', origin: 'ModA' };
const CHANGES = { treeName: 'Patch.esp', moves: [], deletions: [], documents: [] };

function setup(selection: readonly PluginsTreeNode[] = [], ...answers: (string | undefined)[]) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
  client.setCommandResult('getRenameSourceChanges', CHANGES);
  client.setCommandResult('moveLastWritten', { moved: true });
  client.setQueryAnswer('getPluginDependants', { dependants: [], unreadable: [] });
  const dialog = scriptedDialog(...answers);
  const stepsWhenAsked: string[][] = [];
  const ask = Object.assign<AskQuestion, { asked: typeof dialog.asked }>(
    (...args) => { stepsWhenAsked.push([...progressSteps]); return dialog(...args); }, { asked: dialog.asked });
  const renameFiles = vi.fn().mockResolvedValue(undefined);
  const adapter = { ...adapterOver('/instance'), renamePlugin: renameFiles, checkPluginRename: vi.fn().mockResolvedValue({ applied: true }) };
  const instance = {
    value: instanceValueFixture({
      gameRelease: 'Fallout4',
      plugins: [held('Patch.esp', 'ModA'), held('Taken.esp', 'ModA'), held('Elsewhere.esp', 'ModB')],
    }),
    quiet: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } finally {
        progressSteps.push('Instance loader: read every file again');
      }
    },
  };
  const reporter = recordingReporter();
  const apply = vi.fn<SourceEditing['applyWorkspaceChanges']>().mockResolvedValue([]);
  const queue = oneAtATime();
  const queued = vi.fn();
  const source: SourceEditing = {
    unsaved: () => [{ path: '/instance/mods/ModA/plugin-source/Patch.esp/h.json', text: '{}' }],
    applyWorkspaceChanges: apply,
    oneAtATime: (job) => { queued(); return queue(job); },
    refreshSourceControlFor: vi.fn(),
  };
  registerRenamePluginCommand({ client, adapter, ask, instance, reporter, source }, () => selection);
  const run = present(handlers.get('modbench.plugin.rename'), 'the rename plugin command');
  const validate = async (value: string): Promise<string | undefined> => {
    let validated: string | undefined;
    showInputBox.mockImplementationOnce((options: { validateInput: (v: string) => string | undefined }) => {
      validated = options.validateInput(value);
      return Promise.resolve(undefined);
    });
    await run(new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin));
    return validated;
  };
  return { client, ask, stepsWhenAsked, renameFiles, reporter, source, apply, queued, run, validate };
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
    const { client, renameFiles, reporter, source, run } = setup();

    await run(row());

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'Patch.esp' }));
    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([{ method: 'getRenameSourceChanges', args: [PLUGIN, 'Renamed.esp', source.unsaved()] }]);
    expect(renameFiles).toHaveBeenCalledWith({ kind: 'mod', name: 'ModA' }, 'Patch.esp', 'Renamed.esp', 'Fallout4');
    expect(progressSteps).toEqual(['progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes']);
    expect(reporter.reports).toEqual([]);
  });

  it('takes the one selected plugin from a key or the palette, which pass no row', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, source, run } = setup([row()]);

    await run();

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([{ method: 'getRenameSourceChanges', args: [PLUGIN, 'Renamed.esp', source.unsaved()] }]);
  });

  it('renames nothing when the confirmation of its dependants is declined, and says nothing', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, ask, renameFiles, reporter, run } = setup([], undefined);
    client.setQueryAnswer('getPluginDependants', { dependants: [{ name: 'Child.esp', origin: 'ModB' }], unreadable: [] });

    await run(row());

    expect(ask.asked).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(renameFiles).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(progressSteps).toEqual([]);
  });

  it('asks before the Plugins bar opens, so the question does not hold the bar or the reads', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, stepsWhenAsked, run } = setup([], 'Rename');
    client.setQueryAnswer('getPluginDependants', { dependants: [{ name: 'Child.esp', origin: 'ModB' }], unreadable: [] });

    await run(row());

    expect(stepsWhenAsked).toEqual([[]]);
    expect(progressSteps[0]).toBe('progress opens on modbench.pluginListTree');
  });

  it('tells a refusal that came before any write, such as an index still reading', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, run } = setup();
    client.setQueryFailure('getPluginDependants', new Error('mEdit has not finished indexing the plugins.'));

    await run(row());

    expect(renameFiles).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'mEdit has not finished indexing the plugins.', detail: undefined }]);
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Patch.esp']])('renames nothing on %s', async (_, answer) => {
    showInputBox.mockResolvedValueOnce(answer);
    const { client, renameFiles, run } = setup();

    await run(row());

    expect(client.calls.filter((c) => c.method === 'getRenameSourceChanges')).toEqual([]);
    expect(renameFiles).not.toHaveBeenCalled();
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

    it('refuses a name with no plugin extension, and one mEdit leaves out', async () => {
      const { validate, client } = setup();
      expect(await validate('Patch.txt')).toBe('Extension must be .esm, .esl, or .esp');
      client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esp']);
      expect(await validate('Patch.esl')).toBe('Extension must be .esm or .esp');
    });

    it('refuses a name the plugin\'s own place holds, a case-only rename of itself too', async () => {
      const { validate } = setup();
      expect(await validate('taken.ESP')).toBe('"ModA" already holds "taken.ESP".');
      expect(await validate('PATCH.esp')).toBe('"ModA" already holds "PATCH.esp".');
    });

    it('lets through a name only another place holds', async () => {
      const { validate } = setup();
      expect(await validate('Elsewhere.esp')).toBeUndefined();
    });
  });

  it('applies the changes as one workspace edit one at a time, and refreshes Source Control for the plugin', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { source, apply, queued, run } = setup();

    await run(row());

    expect(queued).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith([CHANGES]);
    expect(source.refreshSourceControlFor).toHaveBeenCalledWith(PLUGIN);
  });

  it('names the rename and the plugin, and points to git, when VS Code cannot apply the changes', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, source, apply, run } = setup();
    apply.mockRejectedValueOnce(new Error('EEXIST'));

    await run(row());

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not rename "Patch.esp" (ModA): its plugin source may be partly renamed. Reverting the source rename in git undoes it.',
      detail: 'EEXIST VS Code stops at the first change it cannot make, so some changes may have landed.',
    }]);
    expect(source.refreshSourceControlFor).toHaveBeenCalledWith(PLUGIN);
    expect(client.calls.filter((c) => c.method === 'moveLastWritten')).toEqual([]);
    expect(renameFiles).not.toHaveBeenCalled();
  });

  it('names the files left unsaved, moves nothing and renames no file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, apply, run } = setup();
    apply.mockResolvedValueOnce(['/m/plugin-source/Renamed.esp/h.json']);

    await run(row());

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not save the rename of "Patch.esp" (ModA) in full. Reverting the source rename in git undoes it.',
      detail: 'VS Code did not save /m/plugin-source/Renamed.esp/h.json.',
    }]);
    expect(client.calls.filter((c) => c.method === 'moveLastWritten')).toEqual([]);
    expect(renameFiles).not.toHaveBeenCalled();
  });

  it('tells a refused source, writing no file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, run } = setup();
    client.setCommandResult('getRenameSourceChanges', { refused: true, message: 'Could not rename the source of "Patch.esp" — NotTracked' });

    await run(row());

    expect(renameFiles).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rename the source of "Patch.esp" — NotTracked', detail: undefined },
    ]);
  });

  it('names the plugin and says its source was renamed when the file and lines failed after it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { renameFiles, reporter, run } = setup();
    renameFiles.mockRejectedValueOnce(new Error('disk full'));

    await run(row());

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not rename "Patch.esp" (ModA): its plugin source was renamed, its file and lines were not. Reverting the source rename in git undoes it.',
      detail: 'disk full',
    }]);
  });
});
