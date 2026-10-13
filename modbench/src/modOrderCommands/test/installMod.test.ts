import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modlistCommands } from '../modOrderCommands';
import { adapterOver, readDownloadedFileMeta } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';
import type { ArchiveReader } from '../../instanceAdapter/instanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const MOD = 'Freshly Installed Mod';
const GAME_NAME = 'Fallout 4';
const RELEASE = ['Installed.esp'];

describe('installMod', () => {
  let root: string;
  const commands = (archives: ArchiveReader = fakeArchiveReader(RELEASE)) =>
    modlistCommands(adapterOver(root, { archives }), new InMemoryMEditClient());
  const downloadedFile = (name: string) => ({ kind: 'downloadedFile' as const, name, path: join(root, 'downloads', name) });

  beforeEach(() => {
    root = cloneCorpusFixture();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('refuses a new mod whose name a folder holds, in the words create empty mod uses', async () => {
    const outcome = await commands().installMod({ kind: 'archive', path: '/elsewhere/a.7z' }, { kind: 'new', name: 'Harder VATS' }, GAME_NAME);

    expect(outcome).toEqual({
      applied: false,
      refusal: 'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.',
    });
  });

  it('refuses an upgrade of a mod no folder holds', async () => {
    const outcome = await commands().installMod({ kind: 'archive', path: '/elsewhere/a.7z' }, { kind: 'upgrade', name: 'Vanished Mod' }, GAME_NAME);

    expect(outcome).toEqual({ applied: false, refusal: 'Cannot upgrade "Vanished Mod": there is no folder by that name under mods/.' });
  });

  it('refuses with why the install failed', async () => {
    const corrupt = { ...fakeArchiveReader([]), extract: () => Promise.reject(new Error('archive is corrupt')) };

    const outcome = await commands(corrupt).installMod({ kind: 'archive', path: '/elsewhere/a.7z' }, { kind: 'new', name: MOD }, GAME_NAME);

    expect(outcome).toEqual({ applied: false, refusal: 'archive is corrupt' });
  });

  it('says whether the source is a scripted installer', async () => {
    const outcome = await commands(fakeArchiveReader(['fomod/ModuleConfig.xml', 'Core/a.esp']))
      .installMod({ kind: 'archive', path: '/elsewhere/a.7z' }, { kind: 'new', name: MOD }, GAME_NAME);

    expect(outcome).toEqual({ applied: true, isFomod: true });
  });

  it('records an archive\'s file name as the mod\'s installation file, and marks no downloaded file, even one of its name', async () => {
    await writeFile(join(root, 'downloads', 'Freshly-1-0.7z'), 'archive bytes');

    const outcome = await commands().installMod({ kind: 'archive', path: '/elsewhere/Freshly-1-0.7z' }, { kind: 'new', name: MOD }, GAME_NAME);

    expect(outcome).toEqual({ applied: true, isFomod: false });
    expect(await adapterOver(root).modMeta(MOD)).toEqual({ archiveFilename: 'Freshly-1-0.7z' });
    expect(await readDownloadedFileMeta(root, 'Freshly-1-0.7z')).toBeUndefined();
  });

  it('records a downloaded file\'s name, Nexus ids and version in the mod\'s meta, and marks it installed', async () => {
    await writeFile(join(root, 'downloads', 'Freshly-1-0.7z'), 'archive bytes');

    const outcome = await commands().installMod(
      { ...downloadedFile('Freshly-1-0.7z'), modID: '111', fileID: '222', version: '3.0.0' }, { kind: 'new', name: MOD }, GAME_NAME);

    expect(outcome).toEqual({ applied: true, isFomod: false });
    expect(await adapterOver(root).modMeta(MOD)).toEqual({
      archiveFilename: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFiles: [{ nexusId: '111', fileId: '222' }],
    });
    expect(await readDownloadedFileMeta(root, 'Freshly-1-0.7z')).toMatchObject({ status: 'Installed' });
  });

  it.each([
    ['its metadata cannot be written', async (path: string) => {
      await writeFile(path, 'archive bytes');
      await mkdir(`${path}.meta`);
    }, /EISDIR/],
    ['it is gone', () => Promise.resolve(), /"Freshly-1-0.7z" is gone from disk/],
  ])('reports a downloaded file it could not mark, because %s, beside the landed mod', async (_, arrange, why) => {
    const file = downloadedFile('Freshly-1-0.7z');
    await arrange(file.path);

    const outcome = await commands().installMod(file, { kind: 'new', name: MOD }, GAME_NAME);

    expect(outcome).toMatchObject({ applied: true, isFomod: false });
    expect(outcome.applied && outcome.downloadRefusal).toMatch(why);
  });
});
