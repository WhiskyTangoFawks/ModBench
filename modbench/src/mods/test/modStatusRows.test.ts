import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type { ModStatus } from '../../manifestAdapter/manifestAdapter';
import type { InstanceValue } from '../../instanceLoader/instance';
import { status } from '../../test/modStatusFixture';
import { modsViewOn } from './modsViewOn';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { HeldModStatuses } from '../../test/heldModStatuses';
import { file, folder, mod as unversioned } from './indexedValue';

const mod = (name: string) => ({ ...unversioned(name), version: '1.0' });

function viewHolding(held: readonly ModStatus[], holdsRepository = true, over: Partial<InstanceValue> = {}) {
  const statuses = new HeldModStatuses();
  const value = instanceValueFixture({
    holdsRepository,
    mods: [mod('ModA'), mod('ModB'), mod('ModC')],
    filesByMod: new Map([['ModA', [file('mods/ModA', 'meshes/a.nif'), file('mods/ModA', 'readme.txt')]]]),
    foldersByMod: new Map([['ModA', [folder('mods/ModA', 'meshes')]]]),
    ...over,
  });
  const shown = modsViewOn({ value, statuses });
  statuses.answer(held);
  return { ...shown, statuses };
}

describe('a mod row says its status against its manifest after its version (mods.md, A row, Mod)', () => {
  it.each([
    ['no status yet', [], true, '1.0'],
    ['a folder that matches its manifest', [status('ModA')], true, '1.0'],
    ['no manifest', [status('ModA', { noManifest: true })], true, '1.0 · no manifest'],
    ['a file whose bytes differ', [status('ModA', { differing: ['a.nif'] })], true, '1.0 · differs'],
    ['a file no line names', [status('ModA', { namedByNoLine: ['mine.txt'] })], true, '1.0 · differs'],
    ['a file a line names that is gone', [status('ModA', { gone: ['b.nif'] })], true, '1.0 · differs'],
    ['files its package does not hold', [status('ModA', { notInPackage: ['a.esp', 'b.esp'] })], true, '1.0'],
    ['files its package holds with other bytes', [status('ModA', { otherBytes: ['a.esp'] })], true, '1.0'],
    ['a difference and a file its package does not hold', [status('ModA', { differing: ['a.nif'], notInPackage: ['a.esp'] })], true, '1.0 · differs'],
    ['a package with no host', [status('ModA', { noHost: ['the game folder'] })], true, '1.0'],
    ['no manifest while the instance holds no repository', [status('ModA', { noManifest: true })], false, '1.0'],
  ])('%s', async (_case, held, holdsRepository, description) => {
    const { row } = viewHolding(held, holdsRepository);

    expect((await row('ModA')).description).toBe(description);
  });

  it('says in its tooltip how many files its manifest names and its folder lacks', async () => {
    const { row } = viewHolding([status('ModA', { gone: ['a.nif', 'b.nif'] })]);

    expect((await row('ModA')).tooltip).toBe('ModA · 1.0 · its folder lacks 2 files its manifest names');
  });

  it('shows the status Mod status derives next', async () => {
    const { row, view, statuses } = viewHolding([]);
    const fired = vi.fn();
    view.treeDataProvider.onDidChangeTreeData?.(fired);

    statuses.answer([status('ModA', { noManifest: true })]);

    expect([fired.mock.calls.length, (await row('ModA')).description]).toEqual([1, '1.0 · no manifest']);
  });
});

describe('a separator row has no description, since a separator has no manifest (mods.md, A row, Separator)', () => {
  const separatorShown = (held: ModStatus) => viewHolding([held], true, {
    mods: [{ kind: 'separator', name: 'weapons', enabled: true }, mod('ModA')],
    modFolders: [{ kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' }],
    modNames: new Map([['separator:weapons', 'Weapons_separator']]),
  });

  it.each([
    ['no manifest', status('Weapons_separator', { noManifest: true })],
    ['a file that differs', status('Weapons_separator', { namedByNoLine: ['mine.txt'] })],
  ])('says nothing and does not count in the view\'s badge, whatever status is held for %s', async (_case, held) => {
    const { row, view } = separatorShown(held);

    expect([(await row('weapons')).description, view.badge]).toEqual([undefined, undefined]);
  });
});

describe('a file row says differs when its bytes differ or no line names it, and a folder when a file in it does (mods.md, A row, File and folder)', () => {
  it.each([
    ['a file whose bytes differ, and the folder that holds it', status('ModA', { differing: ['meshes/a.nif'] }), ['differs', 'differs', undefined]],
    ['a file no line names', status('ModA', { namedByNoLine: ['readme.txt'] }), [undefined, undefined, 'differs']],
  ])('says differs on %s, and nothing on a file that matches', async (_case, held, expected) => {
    const { row } = viewHolding([held]);
    const modRow = await row('ModA');
    const meshes = await row('meshes', modRow);

    expect([meshes.description, (await row('a.nif', meshes)).description, (await row('readme.txt', modRow)).description]).toEqual(expected);
  });
});

describe('a file row says ignored when its manifest ignores it, and its menu keys on that (mods.md, A row, File and folder; Menus and keys)', () => {
  it('says ignored on the file its manifest ignores only, and does not count it in the badge', async () => {
    const { row, view } = viewHolding([status('ModA', { ignored: ['readme.txt'], ignoreEntries: ['readme.txt'] })]);
    const modRow = await row('ModA');
    const meshes = await row('meshes', modRow);
    const ignored = await row('readme.txt', modRow);

    expect([ignored.description, ignored.contextValue, (await row('a.nif', meshes)).contextValue, view.badge])
      .toEqual(['ignored', expect.stringMatching(/\bignored\b.*\bignoreEntry\b|\bignoreEntry\b.*\bignored\b/), expect.not.stringMatching(/\bignored\b/), undefined]);
  });

  it('says ignored, with no entry of its own, on a file under an ignored folder', async () => {
    const { row } = viewHolding([status('ModA', { ignored: ['meshes/a.nif'], ignoreEntries: ['meshes'] })]);
    const under = await row('a.nif', await row('meshes', await row('ModA')));

    expect([under.description, under.contextValue]).toEqual(['ignored', expect.not.stringMatching(/ignoreEntry/)]);
    expect(under.contextValue).toMatch(/\bignored\b/);
  });
});

describe('a mod whose whole folder git holds (mods.md, Menus and keys: Mod menu)', () => {
  it('says so in its row\'s context, and says no manifest nor differs', async () => {
    const { row, view } = viewHolding([status('ModA', { heldWhole: true }), status('ModB')]);
    const [held, other] = [await row('ModA'), await row('ModB')];

    expect([held.contextValue, other.contextValue, held.description, view.badge]).toEqual([
      expect.stringMatching(/\bheldWhole\b/), expect.not.stringMatching(/heldWhole/), '1.0', undefined,
    ]);
  });
});

describe('the view\'s badge counts the mods that differ or have no manifest (mods.md, The view)', () => {
  it('counts them while the instance holds a repository', () => {
    const { view } = viewHolding([status('ModA', { noManifest: true }), status('ModB', { gone: ['a.nif'] }), status('ModC')]);

    expect(view.badge).toEqual({ value: 2, tooltip: 'Mods that differ from their manifests or have none: 2' });
  });

  it.each([
    ['no mod differs', [status('ModA')], true],
    ['the instance holds no repository', [status('ModA', { noManifest: true })], false],
  ])('shows none when %s', (_case, statuses, holdsRepository) => {
    expect(viewHolding(statuses, holdsRepository).view.badge).toBeUndefined();
  });
});

describe('an unreadable archive keeps what its row says of the manifest, and adds why (mods.md, The tree, story 14)', () => {
  it.each([
    ['ignored', status('ModA', { ignored: ['readme.txt'], ignoreEntries: ['readme.txt'] }), 'ignored'],
    ['differs', status('ModA', { namedByNoLine: ['readme.txt'] }), 'differs'],
  ])('says %s, then why it cannot be read, and keeps its path in the tooltip', async (_case, held, saying) => {
    const readme = file('mods/ModA', 'readme.txt');
    const { row } = viewHolding([held], true, { archiveContents: new Map([[readme.sourcePath, { kind: 'unreadable', reason: 'it is no BA2' }]]) });

    const archive = await row('readme.txt', await row('ModA'));

    expect([archive.description, archive.tooltip]).toEqual([`${saying} · cannot be read: it is no BA2`, 'readme.txt\ncannot be read: it is no BA2']);
  });
});
