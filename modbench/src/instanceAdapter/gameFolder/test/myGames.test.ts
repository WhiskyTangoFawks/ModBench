import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { onPosix } from '../../../test/platform';
import type { Machine } from '../../instanceAdapter';
import { gameOnDisk, instanceOnDisk, settingsNaming } from '../../test/instanceOnDisk';
import { steamIn, steamPrefixIn } from '../../test/steamOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const ARCHIVE = 'Mine.ba2';
const notFoundNote = (looked: string): string =>
  `The profile Default keeps no game INIs of its own, and the game's were not found: the archives listed are its default INI's. Looked at ${looked}.`;

describe('the My Games folder whose INIs list the archives of a profile that keeps none of its own', () => {
  let base: string;
  let game: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'my-games-'));
    game = await gameOnDisk();
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(game, { recursive: true, force: true });
  });

  const myGamesIn = async (documents: string, name = 'Fallout4'): Promise<void> => {
    await mkdir(join(documents, 'My Games', name), { recursive: true });
    await writeFile(join(documents, 'My Games', name, `${name}.ini`), `[Archive]\nsResourceIndexFileList=${ARCHIVE}\n`);
  };
  const instanceAt = async (place: string, gameName?: string): Promise<string> => {
    const made = await instanceOnDisk({ 'ModOrganizer.ini': settingsNaming(gameName) });
    await mkdir(join(place, '..'), { recursive: true });
    await rename(made, place);
    return place;
  };
  const archivesOf = async (machine: Partial<Machine>, { instance = join(base, 'MO2'), gameName }: { instance?: string; gameName?: string } = {}) => {
    const adapter = adapterOver(await instanceAt(instance, gameName), { gameFolderSettingValue: game, machine });
    const { archiveList, archiveListNotes } = await adapter.reading();
    return { archiveList, archiveListNotes };
  };
  const found = { archiveList: [ARCHIVE], archiveListNotes: [] };

  describe('on Windows', () => {
    const onWindows = (documentsFolder: Machine['documentsFolder']): Partial<Machine> => ({ platform: 'win32', documentsFolder });

    it('is under the Documents known folder, wherever Documents has been redirected to', async () => {
      const redirected = join(base, 'D-drive', 'Documents');
      await myGamesIn(redirected);

      expect(await archivesOf(onWindows(() => Promise.resolve(redirected)))).toEqual(found);
    });

    it('names the Documents folder it looked in when it has no folder for the game', async () => {
      const documents = join(base, 'Documents');
      await mkdir(documents);

      expect((await archivesOf(onWindows(() => Promise.resolve(documents)))).archiveListNotes)
        .toEqual([notFoundNote(`the Documents folder, ${documents}: no My Games/Fallout4 folder in it`)]);
    });

    const readingsOver = async (documents: Machine['documentsFolder']): Promise<() => Promise<readonly string[]>> => {
      const adapter = adapterOver(await instanceAt(join(base, 'MO2')), { gameFolderSettingValue: game, machine: onWindows(documents) });
      return async () => (await adapter.reading()).archiveList;
    };

    it('asks the known folder once, however many times it resolves', async () => {
      await myGamesIn(base);
      const documents = vi.fn(() => Promise.resolve(base));
      const archives = await readingsOver(documents);

      expect([await archives(), await archives(), documents.mock.calls.length]).toEqual([[ARCHIVE], [ARCHIVE], 1]);
    });

    it('asks again after a failure, so a transient one does not stick', async () => {
      await myGamesIn(base);
      const archives = await readingsOver(vi.fn<Machine['documentsFolder']>().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue(base));

      expect([await archives(), await archives()]).toEqual([[], [ARCHIVE]]);
    });

    it('says why the known folder could not be asked', async () => {
      expect((await archivesOf(onWindows(() => Promise.reject(new Error('no known folder'))))).archiveListNotes)
        .toEqual([notFoundNote('the Documents folder: no known folder')]);
    });
  });

  onPosix.describe('on Linux (Wine prefixes are POSIX paths, so only Linux holds one)', () => {
    const prefixDocuments = (prefix: string, user: string): string => join(prefix, 'drive_c', 'users', user, 'Documents');

    it('is in the Steam compatdata prefix of the release\'s app id', async () => {
      await myGamesIn(prefixDocuments(steamPrefixIn(base), 'steamuser'));

      expect(await archivesOf(await steamIn(base))).toEqual(found);
    });

    it('is else in the Wine prefix whose drive_c holds the instance', async () => {
      const prefix = join(base, 'wineprefix');
      await myGamesIn(prefixDocuments(prefix, 'steamuser'));

      expect(await archivesOf({}, { instance: join(prefix, 'drive_c', 'Modding', 'MO2') })).toEqual(found);
    });

    it('names every place it looked when none resolves', async () => {
      const prefix = steamPrefixIn(base);
      await mkdir(prefixDocuments(prefix, 'steamuser'), { recursive: true });

      expect((await archivesOf(await steamIn(base))).archiveListNotes).toEqual([notFoundNote([
        `the Steam prefix of app 377160, ${prefix}: no My Games/Fallout4 folder in its Documents`,
        `the Wine prefix holding the instance: ${join(base, 'MO2')} is under no drive_c`,
      ].join('; '))]);
    });

    it('does not ask Steam for a release with no app id', async () => {
      const { archiveListNotes } = await archivesOf(await steamIn(base), { gameName: 'Skyrim VR' });

      expect(archiveListNotes).toEqual([notFoundNote([
        'the Steam prefix: Modbench has no Steam entry for this game',
        `the Wine prefix holding the instance: ${join(base, 'MO2')} is under no drive_c`,
      ].join('; '))]);
    });
  });
});
