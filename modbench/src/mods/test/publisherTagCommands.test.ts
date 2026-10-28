import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri } from '../../test/vscodeMock';

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
    Uri,
  };
});

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';
import { AgentCall } from '../../drivingLib/agentGesture';
import { registerPublisherTagCommands, publisherKeyContext } from '../publisherTagCommands';
import { FileNode, FolderNode } from '../modFiles';
import { ModNode, OverwriteNode, type ModlistNode } from '../ModListProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InstanceValue, PublisherTag } from '../../instanceLoader/instance';
import { fakeInstanceAdapter, fileIn, modFoldersOf, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { modCommands } from '../../modCommands/modCommands';
import { unreadStatus } from '../../test/unreadStatus';

const INCLUDE: PublisherTag = { name: 'Include', badge: 'IN', marksPaths: true };
const ALWAYS_ENABLED: PublisherTag = { name: 'Always Enabled', badge: 'AE', marksPaths: false };
const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };
const DECLARED = [INCLUDE, IGNORE, ALWAYS_ENABLED];

const LISTED: Record<string, readonly PublisherTag[]> = {
  '/instance/mods/M': [INCLUDE, ALWAYS_ENABLED],
  '/instance/mods/M/a.dds': [INCLUDE],
  '/instance/mods/M/textures': [IGNORE],
};
const value: InstanceValue = {
  ...instanceValueFixture({
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map([['M', '/instance/mods/M'], ['N', '/instance/mods/N']]), sourceDirs: new Map() },
  }),
  publisherTags: DECLARED,
  publisherConfiguration: { kind: 'read', covering: () => [], listed: (path) => LISTED[path] ?? [], pathProblems: [] },
};

const instance = { ...instanceThatReads, value };

const origin = { kind: 'mod', name: 'M' } as const;
const modM = new ModNode({ kind: 'mod', name: 'M', enabled: true });
const modN = new ModNode({ kind: 'mod', name: 'N', enabled: true });
const fileA = new FileNode(modM, origin, fileIn('/instance/mods/M', 'a.dds'), 'a.dds');
const fileB = new FileNode(modM, origin, fileIn('/instance/mods/M', 'b.dds'), 'b.dds');
const folderTextures = new FolderNode(modM, origin, { relativePath: 'textures', path: '/instance/mods/M/textures', excluded: false }, [], [], 'textures');
const inOverwrite = new FileNode(new OverwriteNode([], 'MO2'), { kind: 'runtimeOutput' }, fileIn('/instance/mods/M', 'a.dds'), 'a.dds');

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === commandId);
  if (!call) throw new Error(`command not registered: ${commandId}`);
  return Promise.resolve(call[1](...args));
}

const register = (selection: readonly ModlistNode[] = [], answers: InstanceAnswers = {}) => {
  const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersOf('M', 'N') }), { publisherTags: DECLARED, ...answers });
  const reporter = recordingReporter();
  registerPublisherTagCommands(modCommands(fake.adapter, { changeSourceManifest: () => Promise.reject(new Error('unscripted')) }, unreadStatus), instance, () => selection, reporter);
  return { fake, reporter };
};

const tagChange = (change: 'add' | 'remove', tag: string, ...paths: string[]) => ({ verb: 'changePublisherTag', change, tag, paths });
const inModM = (relativePath: string) => join('/instance/mods/M', relativePath);

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
});

describe('the keys the publisher tag items of the menus wait on (mods.md, Menus and keys)', () => {
  const keys = { hasPublisher: true, hasPathPublisher: true };

  it.each<[string, InstanceValue, ModlistNode[], object]>([
    ['a mod row whose folder holds a tag', value, [modM, fileB], { ...keys, holdsPublisherTag: true }],
    ['no row that holds a tag', value, [fileB, modN], { ...keys, holdsPublisherTag: false }],
    ['a file row that holds a tag', value, [modN, fileA], { ...keys, holdsPublisherTag: true }],
    ['a folder row that holds a tag', value, [modN, folderTextures], { ...keys, holdsPublisherTag: true }],
    ['a publisher whose tags mark no path, over no row', { ...value, publisherTags: [ALWAYS_ENABLED] }, [], { hasPublisher: true, hasPathPublisher: false, holdsPublisherTag: false }],
    ['an Overwrite row alone, though the configuration lists a tag on its path', value, [inOverwrite], { holdsTaggableRow: false, holdsPublisherTag: false }],
    ['an Overwrite row beside a mod that holds no tag', value, [inOverwrite, modN], { holdsTaggableRow: true, holdsPublisherTag: false }],
    ['an Overwrite row beside a file that holds a tag', value, [inOverwrite, fileA], { holdsTaggableRow: true, holdsPublisherTag: true }],
  ])('over %s', (_case, state, selection, expected) => {
    expect(publisherKeyContext(state, selection)).toMatchObject(expected);
  });

  it.each([{ kind: 'none' }, { kind: 'unreadable', reason: 'x' }] as const)('say no publisher while its configuration is %j', (publisherConfiguration) => {
    expect(publisherKeyContext({ ...value, publisherConfiguration }, [modM])).toMatchObject({ hasPublisher: false, hasPathPublisher: false, holdsPublisherTag: false });
  });
});

describe('add publisher tag (publishing.md, Publisher tags, story 2)', () => {
  it('offers every declared tag over mods, and adds the picked one to every selected mod', async () => {
    pickByLabel('Always Enabled');
    const { fake } = register();

    await invoke('modbench.mod.addPublisherTag', modM, [modM, modN, fileA]);

    expect(offered).toEqual(['Include', 'Ignore', 'Always Enabled']);
    expect(fake.calls).toEqual([tagChange('add', 'Always Enabled', '/instance/mods/M', '/instance/mods/N')]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'Instance loader: read every file again', 'progress closes']);
  });

  it('offers only the tags that mark paths over files and folders, and adds to the files and folders alone', async () => {
    pickByLabel('Ignore');
    const { fake } = register();

    await invoke('modbench.mod.addPublisherTag', fileA, [fileA, folderTextures, modM]);

    expect(offered).toEqual(['Include', 'Ignore']);
    expect(fake.calls).toEqual([tagChange('add', 'Ignore', inModM('a.dds'), inModM('textures'))]);
  });

  it('takes the view\'s selection from the palette', async () => {
    pickByLabel('Include');
    const { fake } = register([fileB]);

    await invoke('modbench.mod.addPublisherTag');

    expect(fake.calls).toEqual([tagChange('add', 'Include', inModM('b.dds'))]);
  });

  it('changes nothing on Esc', async () => {
    escape();
    const { fake, reporter } = register();

    await invoke('modbench.mod.addPublisherTag', modM);

    expect([fake.calls, reporter.reports]).toEqual([[], []]);
  });

  it('names each refused row and why, and nothing for those that landed', async () => {
    pickByLabel('Include');
    const { reporter } = register([], { outsideInstance: new Set([inModM('a.dds')]) });

    await invoke('modbench.mod.addPublisherTag', fileA, [fileA, fileB]);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not add Include on 1 of 2 file and folder rows.', detail: '"M/a.dds" (It is outside the instance.)' },
    ]);
  });

  it('reports a refusal of the whole selection', async () => {
    pickByLabel('Include');
    const { reporter } = register([], { refusals: refusing('changePublisherTag', 'compiler_settings.json is not JSON') });

    await invoke('modbench.mod.addPublisherTag', modM);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add Include.', detail: 'compiler_settings.json is not JSON' }]);
  });

  it('takes an agent\'s rows and tag without a pick', async () => {
    const { fake } = register();

    await invoke('modbench.mod.addPublisherTag', new AgentCall(
      [{ kind: 'mod', name: 'M' }, { kind: 'file', origin, relativePath: 'textures' }], { tag: 'Include' }));

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([tagChange('add', 'Include', '/instance/mods/M', inModM('textures'))]);
  });
});

describe('remove publisher tag (publishing.md, Publisher tags, story 2)', () => {
  it('offers only the tags the selection holds, in the publisher\'s order, and removes the picked one from every selected row', async () => {
    pickByLabel('Include');
    const { fake } = register();

    await invoke('modbench.mod.removePublisherTag', folderTextures, [folderTextures, fileA, fileB]);

    expect(offered).toEqual(['Include', 'Ignore']);
    expect(fake.calls).toEqual([tagChange('remove', 'Include', inModM('textures'), inModM('a.dds'), inModM('b.dds'))]);
  });

  it('offers nothing, and changes nothing, over rows that hold no tag', async () => {
    const { fake } = register();

    await invoke('modbench.mod.removePublisherTag', fileB, [fileB]);

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});
