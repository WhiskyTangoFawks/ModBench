import { describe, it, expect, vi } from 'vitest';
import type { Mod, OriginFile } from '../../instanceLoader/instance';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, uriFile, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, Uri: { file: uriFile, from: uriFrom },
}));

import type { ModStatus } from '../../client';
import type { InstanceValue } from '../../instanceLoader/instance';
import { status } from '../../test/modStatusFixture';
import { ModListProvider, type ModlistNode } from '../ModListProvider';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';

const mod = (name: string): Mod => ({ kind: 'mod', name, enabled: true, version: '1.0' });
const file = (relativePath: string): OriginFile =>
  ({ relativePath, path: `/instance/mods/ModA/${relativePath}`, sourcePath: `/instance/mods/ModA/${relativePath}`, excluded: false, markedExcluded: false, includedPath: relativePath });

function providerOver(statuses: readonly ModStatus[], holdsRepository = true, over: Partial<InstanceValue> = {}) {
  const byMod = new Map(statuses.map((held) => [held.mod, held]));
  const changed = new EventEmitter<void>();
  const value = instanceValueFixture({
    holdsRepository,
    mods: [mod('ModA'), mod('ModB'), mod('ModC')],
    filesByMod: new Map([['ModA', [file('meshes/a.nif'), file('readme.txt')]]]),
    foldersByMod: new Map([['ModA', [{ relativePath: 'meshes', path: '/instance/mods/ModA/meshes', excluded: false }]]]),
    ...over,
  });
  const provider = new ModListProvider({ instance: new FakeInstance(value), statuses: { of: (name) => byMod.get(name), onDidChange: changed.event } });
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
    ['metadata that differs from its manifest', status('ModA', { metadataDiffers: true }), true, '1.0 · differs'],
    ['files its package does not hold', status('ModA', { notInPackage: ['a.esp', 'b.esp'] }), true, '1.0 · 2 files its package does not hold'],
    ['a difference and a file its package does not hold', status('ModA', { differing: ['a.nif'], notInPackage: ['a.esp'] }), true, '1.0 · differs · 1 file its package does not hold'],
    ['a package with no host', status('ModA', { noHost: true }), true, '1.0 · its package has no host'],
    ['no manifest while the instance holds no repository', status('ModA', { noManifest: true }), false, '1.0'],
  ])('%s', async (_case, held, holdsRepository, description) => {
    const { provider } = providerOver(held ? [held] : [], holdsRepository);

    expect((await row(provider, 'ModA')).description).toBe(description);
  });

  it('says in its tooltip how many files its manifest names and its folder lacks', async () => {
    const { provider } = providerOver([status('ModA', { gone: ['a.nif', 'b.nif'] })]);

    expect((await row(provider, 'ModA')).tooltip).toBe('ModA · 1.0 · its folder lacks 2 files its manifest names');
  });

  it('shows the status mEdit answers next', async () => {
    const { provider, byMod, changed } = providerOver([]);
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);

    byMod.set('ModA', status('ModA', { noManifest: true }));
    changed.fire();

    expect([fired.mock.calls.length, (await row(provider, 'ModA')).description]).toEqual([1, '1.0 · no manifest']);
  });
});

describe('a separator row says no manifest or differs as a mod does, looked up by the name the mod manager gives its folder (mods.md, A row, Separator)', () => {
  const separatorProvider = (held: ModStatus | undefined, holdsRepository = true) => providerOver(held ? [held] : [], holdsRepository, {
    mods: [{ kind: 'separator', name: 'weapons', enabled: true }, mod('ModA')],
    modFolders: [{ kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' }],
    modNames: new Map([['separator:weapons', 'Weapons_separator']]),
  });

  it.each([
    ['no manifest', status('Weapons_separator', { noManifest: true }), true, 'no manifest'],
    ['a file that differs', status('Weapons_separator', { namedByNoLine: ['mine.txt'] }), true, 'differs'],
    ['a manifest', status('Weapons_separator'), true, undefined],
    ['no status yet', undefined, true, undefined],
    ['no manifest while the instance holds no repository', status('Weapons_separator', { noManifest: true }), false, undefined],
  ])('%s', async (_case, held, holdsRepository, description) => {
    const { provider } = separatorProvider(held, holdsRepository);

    expect((await row(provider, 'weapons')).description).toBe(description);
  });

  it('counts in the view\'s badge when it differs', () => {
    const { provider } = separatorProvider(status('Weapons_separator', { namedByNoLine: ['mine.txt'] }));

    expect(provider.badge()?.value).toBe(1);
  });

  it('counts in the view\'s badge with the mods that have none', () => {
    const { provider } = separatorProvider(status('Weapons_separator', { noManifest: true }));

    expect(provider.badge()).toEqual({ value: 1, tooltip: 'Mods that differ from their manifests or have none: 1' });
  });
});

describe('a file row says differs when its bytes differ or no line names it, and a folder when a file in it does (mods.md, A row, File and folder)', () => {
  it('says differs on the file and the folder that holds it, and nothing on a file that matches', async () => {
    const { provider } = providerOver([status('ModA', { differing: ['meshes/a.nif'] })]);
    const modRow = await row(provider, 'ModA');
    const folder = await row(provider, 'meshes', modRow);

    expect([folder.description, (await row(provider, 'a.nif', folder)).description, (await row(provider, 'readme.txt', modRow)).description])
      .toEqual(['differs', 'differs', undefined]);
  });

  it('says differs on a file no line names', async () => {
    const { provider } = providerOver([status('ModA', { namedByNoLine: ['readme.txt'] })]);

    expect((await row(provider, 'readme.txt', await row(provider, 'ModA'))).description).toBe('differs');
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
