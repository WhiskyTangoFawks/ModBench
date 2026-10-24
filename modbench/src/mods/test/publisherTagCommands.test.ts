import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile, uriFrom } from '../../test/vscodeMock';

const { registerCommand, createQuickPick } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  createQuickPick: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand: vi.fn() },
    window: { createQuickPick, withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
    Uri: { file: uriFile, from: uriFrom },
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';
import { AgentCall } from '../../drivingLib/agentGesture';
import { registerPublisherTagCommands, publisherKeyContext } from '../publisherTagCommands';
import { FileNode, FolderNode } from '../modFiles';
import { ModNode, type ModlistNode } from '../ModListProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InstanceValue, PublisherTag } from '../../instanceLoader/instance';

const INCLUDE: PublisherTag = { name: 'Include', badge: 'IN', marksPaths: true };
const ALWAYS_ENABLED: PublisherTag = { name: 'Always Enabled', badge: 'AE', marksPaths: false };
const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };

const COVERED: Record<string, readonly PublisherTag[]> = {
  '/instance/mods/M': [INCLUDE, ALWAYS_ENABLED],
  '/instance/mods/M/a.dds': [INCLUDE],
  '/instance/mods/M/textures': [IGNORE],
};
const value: InstanceValue = {
  ...instanceValueFixture({
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map([['M', '/instance/mods/M'], ['N', '/instance/mods/N']]), sourceDirs: new Map() },
  }),
  publisherTags: [INCLUDE, IGNORE, ALWAYS_ENABLED],
  publisherConfiguration: { kind: 'read', covering: (path) => COVERED[path] ?? [] },
};

const changePublisherTag = vi.fn();
const commands = { changePublisherTag };
const instance = { value, refresh: () => { progressSteps.push('read'); return Promise.resolve(); } };

const origin = { kind: 'mod', name: 'M' } as const;
const modM = new ModNode({ kind: 'mod', name: 'M', enabled: true });
const modN = new ModNode({ kind: 'mod', name: 'N', enabled: true });
const fileA = new FileNode(modM, origin, { relativePath: 'a.dds', path: '/instance/mods/M/a.dds', sourcePath: '', excluded: false, markedExcluded: false, includedPath: 'a.dds' }, 'a.dds');
const fileB = new FileNode(modM, origin, { relativePath: 'b.dds', path: '/instance/mods/M/b.dds', sourcePath: '', excluded: false, markedExcluded: false, includedPath: 'b.dds' }, 'b.dds');
const folderTextures = new FolderNode(modM, origin, { relativePath: 'textures', path: '/instance/mods/M/textures', excluded: false }, [], [], 'textures');

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const register = (selection: readonly ModlistNode[] = [], reporter = recordingReporter()) => {
  registerPublisherTagCommands(commands, instance, () => selection, reporter);
  return reporter;
};

let offered: string[];
const pickByLabel = (label: string) => createQuickPick.mockImplementationOnce(() => quickPickChoosing<{ label: string }>((items) => {
  offered = items.map((item) => item.label);
  return items.find((item) => item.label === label);
}));
const escape = () => createQuickPick.mockImplementationOnce(() => quickPickChoosing<{ label: string }>((items) => {
  offered = items.map((item) => item.label);
  return undefined;
}));

beforeEach(() => {
  vi.clearAllMocks();
  progressSteps.length = 0;
  offered = [];
  changePublisherTag.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });
});

describe('the keys the publisher tag items of the menus wait on (mods.md, Menus and keys)', () => {
  it('say whether the instance has a publisher, one whose tags mark paths, and whether the selection holds a tag', () => {
    expect(publisherKeyContext(value, [modM, fileB])).toEqual({ hasPublisher: true, hasPathPublisher: true, holdsPublisherTag: true });
    expect(publisherKeyContext(value, [fileB, modN])).toEqual({ hasPublisher: true, hasPathPublisher: true, holdsPublisherTag: false });
    expect(publisherKeyContext({ ...value, publisherTags: [ALWAYS_ENABLED] }, [])).toEqual({ hasPublisher: true, hasPathPublisher: false, holdsPublisherTag: false });
  });

  it.each([{ kind: 'none' }, { kind: 'unreadable', reason: 'x' }] as const)('say no publisher while its configuration is %j', (publisherConfiguration) => {
    expect(publisherKeyContext({ ...value, publisherConfiguration }, [modM])).toEqual({ hasPublisher: false, hasPathPublisher: false, holdsPublisherTag: false });
  });
});

describe('modbench.mod.addPublisherTag (publishing.md, Publisher tags, story 2)', () => {
  it('offers every declared tag over mods, and adds the picked one to every selected mod', async () => {
    pickByLabel('Always Enabled');
    register();

    await invoke('modbench.mod.addPublisherTag', modM, [modM, modN, fileA]);

    expect(offered).toEqual(['Include', 'Ignore', 'Always Enabled']);
    expect(changePublisherTag).toHaveBeenCalledWith('add', 'Always Enabled', [{ origin }, { origin: { kind: 'mod', name: 'N' } }]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'read', 'progress closes']);
  });

  it('offers only the tags that mark paths over files and folders, and adds to the files and folders alone', async () => {
    pickByLabel('Ignore');
    register();

    await invoke('modbench.mod.addPublisherTag', fileA, [fileA, folderTextures, modM]);

    expect(offered).toEqual(['Include', 'Ignore']);
    expect(changePublisherTag).toHaveBeenCalledWith('add', 'Ignore', [{ origin, relativePath: 'a.dds' }, { origin, relativePath: 'textures' }]);
  });

  it('takes the view\'s selection from the palette', async () => {
    pickByLabel('Include');
    register([fileB]);

    await invoke('modbench.mod.addPublisherTag');

    expect(changePublisherTag).toHaveBeenCalledWith('add', 'Include', [{ origin, relativePath: 'b.dds' }]);
  });

  it('changes nothing on Esc', async () => {
    escape();
    const reporter = register();

    await invoke('modbench.mod.addPublisherTag', modM);

    expect(changePublisherTag).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
  });

  it('names each refused row and why, and nothing for those that landed', async () => {
    pickByLabel('Include');
    changePublisherTag.mockResolvedValue({
      applied: true, outcome: { landed: [{ origin }], refused: [{ item: { origin, relativePath: 'a.dds' }, reason: 'It is outside the instance.' }] },
    });
    const reporter = register();

    await invoke('modbench.mod.addPublisherTag', fileA, [fileA]);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not add Include on 1 of 1 files and folders.', detail: '"M/a.dds" (It is outside the instance.)' },
    ]);
  });

  it('reports a refusal of the whole selection', async () => {
    pickByLabel('Include');
    changePublisherTag.mockResolvedValue({ applied: false, refusal: 'compiler_settings.json is not JSON' });
    const reporter = register();

    await invoke('modbench.mod.addPublisherTag', modM);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add Include.', detail: 'compiler_settings.json is not JSON' }]);
  });

  it('takes an agent\'s rows and tag without a pick', async () => {
    register();

    await invoke('modbench.mod.addPublisherTag', new AgentCall(
      [{ kind: 'mod', name: 'M' }, { kind: 'file', origin, relativePath: 'textures' }], { tag: 'Include' }));

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(changePublisherTag).toHaveBeenCalledWith('add', 'Include', [{ origin }, { origin, relativePath: 'textures' }]);
  });
});

describe('modbench.mod.removePublisherTag (publishing.md, Publisher tags, story 2)', () => {
  it('offers only the tags the selection holds, in the publisher\'s order, and removes the picked one from every selected row', async () => {
    pickByLabel('Include');
    register();

    await invoke('modbench.mod.removePublisherTag', fileA, [fileA, folderTextures, fileB]);

    expect(offered).toEqual(['Include', 'Ignore']);
    expect(changePublisherTag).toHaveBeenCalledWith('remove', 'Include', [
      { origin, relativePath: 'a.dds' }, { origin, relativePath: 'textures' }, { origin, relativePath: 'b.dds' },
    ]);
  });

  it('offers nothing, and changes nothing, over rows that hold no tag', async () => {
    register();

    await invoke('modbench.mod.removePublisherTag', fileB, [fileB]);

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(changePublisherTag).not.toHaveBeenCalled();
  });
});
