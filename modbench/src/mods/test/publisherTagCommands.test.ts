import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { join } from 'node:path';
import type * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { progressSteps } from '../../test/recordedProgress';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { InstanceValue, PublisherTag } from '../../instanceLoader/instance';
import { fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { file, folder, indexedValueOf, mod } from './indexedValue';

type Row = vscode.TreeItem;
type ModsView = ReturnType<typeof modsViewOn>;

const INCLUDE: PublisherTag = { name: 'Include', badge: 'IN', marksPaths: true };
const ALWAYS_ENABLED: PublisherTag = { name: 'Always Enabled', badge: 'AE', marksPaths: false };
const IGNORE: PublisherTag = { name: 'Ignore', badge: 'IG', marksPaths: true };
const DECLARED = [INCLUDE, IGNORE, ALWAYS_ENABLED];

const LISTED: Record<string, readonly PublisherTag[]> = {
  '/instance/M': [INCLUDE, ALWAYS_ENABLED],
  '/instance/M/a.dds': [INCLUDE],
  '/instance/M/textures': [IGNORE],
  '/instance/Overwrite/a.dds': [INCLUDE],
};

const valueWith = async (over: Partial<InstanceValue>): Promise<InstanceValue> => ({
  ...await indexedValueOf(
    [mod('M'), mod('N')],
    { M: { files: [file('M', 'a.dds'), file('M', 'b.dds'), file('M', 'textures/c.dds')], folders: [folder('M', 'textures')] }, N: { files: [file('N', 'd.dds')] } },
    { files: [file('Overwrite', 'a.dds')] },
  ),
  paths: { overwriteDir: '/instance/Overwrite', downloadsDir: '', modDirs: new Map([['M', '/instance/M'], ['N', '/instance/N']]), sourceDirs: new Map() },
  publisherTags: DECLARED,
  publisherConfiguration: { kind: 'read', covering: () => [], listed: (path) => LISTED[path] ?? [], pathProblems: [], unshippable: { file: '', reason: () => undefined } },
  ...over,
});

const origin = { kind: 'mod', name: 'M' } as const;

const tagging = async (over: Partial<InstanceValue> = {}, answered: InstanceAnswers = {}): Promise<ModsView> =>
  modsViewOn({ value: await valueWith(over), adapter: fakeInstanceAdapter(readingFixture({ modFolders: modFoldersOf('M', 'N') }), { publisherTags: DECLARED, ...answered }) });

type Find = (view: ModsView) => Promise<Row>;
const modM: Find = ({ row }) => row('M');
const modN: Find = ({ row }) => row('N');
const inM = (name: string): Find => async ({ row }) => await row(name, await row('M'));
const fileA = inM('a.dds');
const fileB = inM('b.dds');
const folderTextures = inM('textures');
const inOverwrite: Find = async ({ row }) => await row('a.dds', await row('Overwrite'));

const rowsOf = (view: ModsView, finds: readonly Find[]): Promise<Row[]> => Promise.all(finds.map((find) => find(view)));

const KEYS = ['hasPublisher', 'hasPathPublisher', 'holdsTaggableRow', 'holdsPublisherTag'];
const keysShown = (): Record<string, unknown> => Object.fromEntries(KEYS.map((key) => [key, seen.contextKeys.get(`modbench.mod.${key}`)]));

const tagChange = (change: 'add' | 'remove', tag: string, ...paths: string[]) => ({ verb: 'changePublisherTag', change, tag, paths });
const inModM = (relativePath: string) => join('/instance/mods/M', relativePath);

const picking = (label: string | undefined): void => { answers.createdQuickPick = (items) => items.find((item) => item.label === label); };
const offered = (): string[] | undefined => seen.createdQuickPicks.at(-1)?.items.map(({ label }) => label);

describe('the keys the publisher tag items of the menus wait on (mods.md, Menus and keys)', () => {
  const keys = { hasPublisher: true, hasPathPublisher: true };

  it.each<[string, Partial<InstanceValue>, Find[], object]>([
    ['a mod row whose folder holds a tag', {}, [modM, fileB], { ...keys, holdsPublisherTag: true }],
    ['no row that holds a tag', {}, [fileB, modN], { ...keys, holdsPublisherTag: false }],
    ['a file row that holds a tag', {}, [modN, fileA], { ...keys, holdsPublisherTag: true }],
    ['a folder row that holds a tag', {}, [modN, folderTextures], { ...keys, holdsPublisherTag: true }],
    ['a publisher whose tags mark no path, over no row', { publisherTags: [ALWAYS_ENABLED] }, [], { hasPublisher: true, hasPathPublisher: false, holdsPublisherTag: false }],
    ['an Overwrite row alone, though the configuration lists a tag on its path', {}, [inOverwrite], { holdsTaggableRow: false, holdsPublisherTag: false }],
    ['an Overwrite row beside a mod that holds no tag', {}, [inOverwrite, modN], { holdsTaggableRow: true, holdsPublisherTag: false }],
    ['an Overwrite row beside a file that holds a tag', {}, [inOverwrite, fileA], { holdsTaggableRow: true, holdsPublisherTag: true }],
  ])('over %s', async (_case, state, selection, expected) => {
    const view = await tagging(state);

    view.view.selectRows(await rowsOf(view, selection));

    expect(keysShown()).toMatchObject(expected);
  });

  it.each([{ kind: 'none' }, { kind: 'unreadable', reason: 'x' }] as const)('say no publisher while its configuration is %j', async (publisherConfiguration) => {
    const view = await tagging({ publisherConfiguration });

    view.view.selectRows(await rowsOf(view, [modM]));

    expect(keysShown()).toMatchObject({ hasPublisher: false, hasPathPublisher: false, holdsPublisherTag: false });
  });
});

describe('add publisher tag (publishing.md, Publisher tags, story 2)', () => {
  it('offers every declared tag over mods, and adds the picked one to every selected mod', async () => {
    const view = await tagging();
    picking('Always Enabled');
    const [m, n, a] = await rowsOf(view, [modM, modN, fileA]);

    await view.run('modbench.mod.addPublisherTag', m, [m, n, a]);

    expect(offered()).toEqual(['Include', 'Ignore', 'Always Enabled']);
    expect(view.adapter.calls).toEqual([tagChange('add', 'Always Enabled', '/instance/mods/M', '/instance/mods/N')]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'progress closes']);
  });

  it('offers only the tags that mark paths over files and folders, and adds to the files and folders alone', async () => {
    const view = await tagging();
    picking('Ignore');
    const [a, textures, m] = await rowsOf(view, [fileA, folderTextures, modM]);

    await view.run('modbench.mod.addPublisherTag', a, [a, textures, m]);

    expect(offered()).toEqual(['Include', 'Ignore']);
    expect(view.adapter.calls).toEqual([tagChange('add', 'Ignore', inModM('a.dds'), inModM('textures'))]);
  });

  it('takes the view\'s selection from the palette', async () => {
    const view = await tagging();
    picking('Include');
    view.view.selectRows(await rowsOf(view, [fileB]));

    await view.run('modbench.mod.addPublisherTag');

    expect(view.adapter.calls).toEqual([tagChange('add', 'Include', inModM('b.dds'))]);
  });

  it('changes nothing on Esc', async () => {
    const view = await tagging();

    await view.run('modbench.mod.addPublisherTag', await modM(view));

    expect([view.adapter.calls, view.reporter.reports]).toEqual([[], []]);
  });

  it('names each refused row and why, and nothing for those that landed', async () => {
    const view = await tagging({}, { outsideInstance: new Set([inModM('a.dds')]) });
    picking('Include');
    const [a, b] = await rowsOf(view, [fileA, fileB]);

    await view.run('modbench.mod.addPublisherTag', a, [a, b]);

    expect(view.reporter.reports).toEqual([
      { severity: 'error', message: 'Could not add Include on 1 of 2 file and folder rows.', detail: '"M/a.dds" (It is outside the instance.)' },
    ]);
  });

  it('reports a refusal of the whole selection', async () => {
    const view = await tagging({}, { refusals: refusing('changePublisherTag', 'compiler_settings.json is not JSON') });
    picking('Include');

    await view.run('modbench.mod.addPublisherTag', await modM(view));

    expect(view.reporter.reports).toEqual([{ severity: 'error', message: 'Failed to add Include.', detail: 'compiler_settings.json is not JSON' }]);
  });

  it('takes an agent\'s rows and tag without a pick', async () => {
    const view = await tagging();

    await view.run('modbench.mod.addPublisherTag', new AgentCall(
      [{ kind: 'mod', name: 'M' }, { kind: 'file', origin, relativePath: 'textures' }], { tag: 'Include' }));

    expect(seen.createdQuickPicks).toEqual([]);
    expect(view.adapter.calls).toEqual([tagChange('add', 'Include', '/instance/mods/M', inModM('textures'))]);
  });
});

describe('remove publisher tag (publishing.md, Publisher tags, story 2)', () => {
  it('offers only the tags the selection holds, in the publisher\'s order, and removes the picked one from every selected row', async () => {
    const view = await tagging();
    picking('Include');
    const [textures, a, b] = await rowsOf(view, [folderTextures, fileA, fileB]);

    await view.run('modbench.mod.removePublisherTag', textures, [textures, a, b]);

    expect(offered()).toEqual(['Include', 'Ignore']);
    expect(view.adapter.calls).toEqual([tagChange('remove', 'Include', inModM('textures'), inModM('a.dds'), inModM('b.dds'))]);
  });

  it('offers nothing, and changes nothing, over rows that hold no tag', async () => {
    const view = await tagging();
    const b = await fileB(view);

    await view.run('modbench.mod.removePublisherTag', b, [b]);

    expect(seen.createdQuickPicks).toEqual([]);
    expect(view.adapter.calls).toEqual([]);
  });
});
