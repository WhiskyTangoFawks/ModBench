import { describe, it, expect } from 'vitest';
import { modlistCommands, type ModSource } from '../modOrderCommands';
import type { InstallSource, InstallTarget } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const MOD = 'Freshly Installed Mod';
const GAME_NAME = 'Fallout 4';
const ARCHIVE: InstallSource = { kind: 'archive', path: '/elsewhere/Freshly-1-0.7z' };
const NEW_MOD: InstallTarget = { kind: 'new', name: MOD };
const DOWNLOADED = { kind: 'downloadedFile', name: 'Freshly-1-0.7z', path: '/downloads/Freshly-1-0.7z' } as const;

function install(source: ModSource, target: InstallTarget = NEW_MOD, answers: InstanceAnswers = {}) {
  const fake = fakeInstanceAdapter(undefined, answers);
  const outcome = modlistCommands(fake.adapter, new InMemoryMEditClient()).installMod(source, target, GAME_NAME);
  return outcome.then((result) => ({ result, calls: fake.calls }));
}

describe('installMod', () => {
  it.each([
    ['a new mod whose name a folder holds, in the words create empty mod uses', { kind: 'new', name: 'Harder VATS' }, 'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.'],
    ['an upgrade of a mod no folder holds', { kind: 'upgrade', name: 'Vanished Mod' }, 'Cannot upgrade "Vanished Mod": there is no folder by that name under mods/.'],
  ] as const)('refuses %s when the adapter lands nothing', async (_, target, refusal) => {
    const { result } = await install(ARCHIVE, target, { installed: { landed: false } });

    expect(result).toEqual({ applied: false, refusal });
  });

  it('refuses a new mod named by blanks and installs nothing', async () => {
    const { result, calls } = await install(ARCHIVE, { kind: 'new', name: '  ' });

    expect(result).toEqual({ applied: false, refusal: 'A mod name cannot be empty.' });
    expect(calls).toEqual([]);
  });

  it('refuses with why the adapter failed', async () => {
    const { result } = await install(ARCHIVE, NEW_MOD, { refusals: refusing('install', 'archive is corrupt') });

    expect(result).toEqual({ applied: false, refusal: 'archive is corrupt' });
  });

  it('says whether the source is a scripted installer, as the adapter found', async () => {
    const { result } = await install(ARCHIVE, NEW_MOD, { installed: { landed: true, isFomod: true } });

    expect(result).toEqual({ applied: true, isFomod: true });
  });

  it.each([
    ['a folder', { kind: 'folder', path: '/elsewhere/Loose' }, { kind: 'folder', path: '/elsewhere/Loose' }, { gameName: GAME_NAME }],
    ['an archive, recording its file name', ARCHIVE, ARCHIVE, { gameName: GAME_NAME, archiveFilename: 'Freshly-1-0.7z' }],
    ['a downloaded file, recording its name, Nexus ids and version', { ...DOWNLOADED, modID: '111', fileID: '222', version: '3.0.0' },
      { kind: 'archive', path: DOWNLOADED.path },
      { gameName: GAME_NAME, archiveFilename: 'Freshly-1-0.7z', nexusId: '111', version: '3.0.0', installedFiles: [{ nexusId: '111', fileId: '222' }] }],
  ] as const)('hands the adapter %s with the keys its meta is to hold', async (_, source, handed, keys) => {
    const { calls } = await install(source);

    expect(calls[0]).toEqual({ verb: 'install', source: handed, target: NEW_MOD, keys });
  });

  it('marks a downloaded file installed once it landed, and marks no file for an archive, though a downloaded file bears its name', async () => {
    expect((await install(DOWNLOADED)).calls.map((call) => call.verb)).toEqual(['install', 'markDownloadedFile']);
    expect((await install(DOWNLOADED)).calls[1]).toEqual({ verb: 'markDownloadedFile', name: DOWNLOADED.name, mark: 'Installed' });
    expect((await install({ kind: 'archive', path: DOWNLOADED.path })).calls.map((call) => call.verb)).toEqual(['install']);
  });

  it('marks no downloaded file when nothing landed', async () => {
    const { calls } = await install(DOWNLOADED, NEW_MOD, { installed: { landed: false } });

    expect(calls.map((call) => call.verb)).toEqual(['install']);
  });

  it.each([
    ['its metadata cannot be written', { refusals: refusing('markDownloadedFile', 'EISDIR: illegal operation on a directory') }, /EISDIR/],
    ['it is gone from disk', { goneDownloads: new Set([DOWNLOADED.name]) }, /"Freshly-1-0.7z" is gone from disk/],
  ] as const)('reports a downloaded file it could not mark, because %s, beside the landed mod', async (_, answers, why) => {
    const { result } = await install(DOWNLOADED, NEW_MOD, answers);

    expect(result).toMatchObject({ applied: true, isFomod: false });
    expect(result.applied && result.downloadRefusal).toMatch(why);
  });
});
