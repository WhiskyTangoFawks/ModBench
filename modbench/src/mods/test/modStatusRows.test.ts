import { describe, it, expect, vi } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri,
}));

import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import { status } from '../../test/modStatusFixture';
import { ModListProvider, type ModlistNode } from '../ModListProvider';
import { OpenRows } from '../openRows';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';

import { file, folder, mod as unversioned } from './indexedValue';
import { recordingReporter } from '../../test/surfacingDoubles';

const mod = (name: string) => ({ ...unversioned(name), version: '1.0' });

function providerOver(statuses: readonly ModStatus[], holdsRepository = true, over: Partial<InstanceValue> = {}) {
  const byMod = new Map(statuses.map((held) => [held.mod, held]));
  const changed = new EventEmitter<void>();
  const value = instanceValueFixture({
    holdsRepository,
    mods: [mod('ModA'), mod('ModB'), mod('ModC')],
    filesByMod: new Map([['ModA', [file('mods/ModA', 'meshes/a.nif'), file('mods/ModA', 'readme.txt')]]]),
    foldersByMod: new Map([['ModA', [folder('mods/ModA', 'meshes')]]]),
    ...over,
  });
  const instance = new FakeInstance(value);
  const provider = new ModListProvider({ reporter: recordingReporter(), instance, open: new OpenRows(instance), statuses: { of: (name) => byMod.get(name), onDidChange: changed.event } });
  return { provider, byMod, changed };
}

const labelOf = (row: ModlistNode): string => (typeof row.label === 'string' ? row.label : row.label?.label ?? '');

async function row(provider: ModListProvider, label: string, parent?: ModlistNode): Promise<ModlistNode> {
  return present((await provider.getChildren(parent)).find((shown) => labelOf(shown) === label), label);
}

describe('a mod row says its status against its manifest after its version (mods.md, A row, Mod)', () => {
  it.each([
    ['no status yet', undefined, true, '1.0'],
    ['a folder that matches its manifest', status('ModA'), true, '1.0'],
    ['no manifest', status('ModA', { noManifest: true }), true, '1.0 · no manifest'],
    ['a file whose bytes differ', status('ModA', { differing: ['a.nif'] }), true, '1.0 · differs'],
    ['a file no line names', status('ModA', { namedByNoLine: ['mine.txt'] }), true, '1.0 · differs'],
    ['a file a line names that is gone', status('ModA', { gone: ['b.nif'] }), true, '1.0 · differs'],
    ['files its package does not hold', status('ModA', { notInPackage: ['a.esp', 'b.esp'] }), true, '1.0'],
    ['files its package holds with other bytes', status('ModA', { otherBytes: ['a.esp'] }), true, '1.0'],
    ['a difference and a file its package does not hold', status('ModA', { differing: ['a.nif'], notInPackage: ['a.esp'] }), true, '1.0 · differs'],
    ['a package with no host', status('ModA', { noHost: ['the game folder'] }), true, '1.0'],
    ['no manifest while the instance holds no repository', status('ModA', { noManifest: true }), false, '1.0'],
  ])('%s', async (_case, held, holdsRepository, description) => {
    const { provider } = providerOver(held ? [held] : [], holdsRepository);

    expect((await row(provider, 'ModA')).description).toBe(description);
  });

  it('says in its tooltip how many files its manifest names and its folder lacks', async () => {
    const { provider } = providerOver([status('ModA', { gone: ['a.nif', 'b.nif'] })]);

    expect((await row(provider, 'ModA')).tooltip).toBe('ModA · 1.0 · its folder lacks 2 files its manifest names');
  });

  it('shows the status Mod status derives next', async () => {
    const { provider, byMod, changed } = providerOver([]);
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);

    byMod.set('ModA', status('ModA', { noManifest: true }));
    changed.fire();

    expect([fired.mock.calls.length, (await row(provider, 'ModA')).description]).toEqual([1, '1.0 · no manifest']);
  });
});

describe('a separator row has no description, since a separator has no manifest (mods.md, A row, Separator)', () => {
  const separatorProvider = (held: ModStatus) => providerOver([held], true, {
    mods: [{ kind: 'separator', name: 'weapons', enabled: true }, mod('ModA')],
    modFolders: [{ kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' }],
    modNames: new Map([['separator:weapons', 'Weapons_separator']]),
  });

  it.each([
    ['no manifest', status('Weapons_separator', { noManifest: true })],
    ['a file that differs', status('Weapons_separator', { namedByNoLine: ['mine.txt'] })],
  ])('says nothing and does not count in the view\'s badge, whatever status is held for %s', async (_case, held) => {
    const { provider } = separatorProvider(held);

    expect([(await row(provider, 'weapons')).description, provider.badge()]).toEqual([undefined, undefined]);
  });
});

describe('a file row says differs when its bytes differ or no line names it, and a folder when a file in it does (mods.md, A row, File and folder)', () => {
  it.each([
    ['a file whose bytes differ, and the folder that holds it', status('ModA', { differing: ['meshes/a.nif'] }), ['differs', 'differs', undefined]],
    ['a file no line names', status('ModA', { namedByNoLine: ['readme.txt'] }), [undefined, undefined, 'differs']],
  ])('says differs on %s, and nothing on a file that matches', async (_case, held, expected) => {
    const { provider } = providerOver([held]);
    const modRow = await row(provider, 'ModA');
    const meshes = await row(provider, 'meshes', modRow);

    expect([meshes.description, (await row(provider, 'a.nif', meshes)).description, (await row(provider, 'readme.txt', modRow)).description])
      .toEqual(expected);
  });
});

describe('a file row says ignored when its manifest ignores it, and its menu keys on that (mods.md, A row, File and folder; Menus and keys)', () => {
  it('says ignored on the file its manifest ignores only, and does not count it in the badge', async () => {
    const { provider } = providerOver([status('ModA', { ignored: ['readme.txt'], ignoreEntries: ['readme.txt'] })]);
    const modRow = await row(provider, 'ModA');
    const meshes = await row(provider, 'meshes', modRow);
    const ignored = await row(provider, 'readme.txt', modRow);

    expect([ignored.description, ignored.contextValue, (await row(provider, 'a.nif', meshes)).contextValue, provider.badge()])
      .toEqual(['ignored', expect.stringMatching(/\bignored\b.*\bignoreEntry\b|\bignoreEntry\b.*\bignored\b/), expect.not.stringMatching(/\bignored\b/), undefined]);
  });

  it('says ignored, with no entry of its own, on a file under an ignored folder', async () => {
    const { provider } = providerOver([status('ModA', { ignored: ['meshes/a.nif'], ignoreEntries: ['meshes'] })]);
    const meshes = await row(provider, 'meshes', await row(provider, 'ModA'));
    const under = await row(provider, 'a.nif', meshes);

    expect([under.description, under.contextValue]).toEqual(['ignored', expect.not.stringMatching(/ignoreEntry/)]);
    expect(under.contextValue).toMatch(/\bignored\b/);
  });
});

describe('the view\'s badge counts the mods that differ or have no manifest (mods.md, The view)', () => {
  it('counts them while the instance holds a repository', () => {
    const { provider } = providerOver([status('ModA', { noManifest: true }), status('ModB', { gone: ['a.nif'] }), status('ModC')]);

    expect(provider.badge()).toEqual({ value: 2, tooltip: 'Mods that differ from their manifests or have none: 2' });
  });

  it.each([
    ['no mod differs', [status('ModA')], true],
    ['the instance holds no repository', [status('ModA', { noManifest: true })], false],
  ])('shows none when %s', (_case, statuses, holdsRepository) => {
    expect(providerOver(statuses, holdsRepository).provider.badge()).toBeUndefined();
  });
});
