import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameDetectors } from '../gameDirectory';
import { myGamesResolver } from '../myGames';

describe('the My Games folder of a release', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'my-games-'));
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const detectors = (over: Partial<GameDetectors> = {}): GameDetectors => ({
    paths: () => Promise.resolve(null),
    winePrefix: () => Promise.resolve(null),
    documents: () => Promise.reject(new Error('no known folder')),
    ...over,
  });
  const myGamesIn = async (documents: string, name = 'Fallout4'): Promise<string> => {
    const folder = join(documents, 'My Games', name);
    await mkdir(folder, { recursive: true });
    return folder;
  };

  describe('on Windows', () => {
    it('is under the Documents known folder, wherever Documents has been redirected to', async () => {
      const redirected = join(base, 'D-drive', 'Documents');
      const expected = await myGamesIn(redirected);

      const resolved = await myGamesResolver(join(base, 'MO2'), detectors({ documents: () => Promise.resolve(redirected) }), 'win32')('Fallout4');

      expect(resolved).toEqual({ kind: 'found', folder: expected });
    });

    it('names the Documents folder it looked in when it has no folder for the game', async () => {
      const documents = join(base, 'Documents');
      await mkdir(documents);

      const resolved = await myGamesResolver(base, detectors({ documents: () => Promise.resolve(documents) }), 'win32')('Fallout4');

      expect(resolved).toEqual({ kind: 'notFound', looked: [`the Documents folder, ${documents}: no My Games/Fallout4 folder in it`] });
    });

    it('asks the known folder once, however many times it resolves', async () => {
      let asked = 0;
      const resolve = myGamesResolver(base, detectors({ documents: () => { asked++; return Promise.resolve(base); } }), 'win32');

      await resolve('Fallout4');
      await resolve('Fallout4');

      expect(asked).toBe(1);
    });

    it('asks again after a failure, so a transient one does not stick', async () => {
      await mkdir(join(base, 'My Games', 'Fallout4'), { recursive: true });
      let asked = 0;
      const resolve = myGamesResolver(base, detectors({
        documents: () => (++asked === 1 ? Promise.reject(new Error('spawn failed')) : Promise.resolve(base)),
      }), 'win32');

      expect(await resolve('Fallout4')).toMatchObject({ kind: 'notFound' });
      expect(await resolve('Fallout4')).toMatchObject({ kind: 'found' });
    });

    it('says why the known folder could not be asked', async () => {
      const resolved = await myGamesResolver(base, detectors(), 'win32')('Fallout4');

      expect(resolved).toEqual({ kind: 'notFound', looked: ['the Documents folder: no known folder'] });
    });
  });

  describe('on Linux', () => {
    const prefixDocuments = (prefix: string, user: string): string => join(prefix, 'drive_c', 'users', user, 'Documents');

    it('is in the Steam compatdata prefix of the release\'s app id', async () => {
      const prefix = join(base, 'compatdata', '377160', 'pfx');
      const expected = await myGamesIn(prefixDocuments(prefix, 'steamuser'));
      const asked: string[] = [];

      const resolved = await myGamesResolver(join(base, 'MO2'), detectors({
        winePrefix: (appId) => {
          asked.push(appId);
          return Promise.resolve(prefix);
        },
      }), 'linux')('Fallout4');

      expect(resolved).toEqual({ kind: 'found', folder: expected });
      expect(asked).toEqual(['377160']);
    });

    it('is else in the Wine prefix whose drive_c holds the instance', async () => {
      const prefix = join(base, 'wineprefix');
      const expected = await myGamesIn(prefixDocuments(prefix, 'steamuser'));
      const instance = join(prefix, 'drive_c', 'Modding', 'MO2');
      await mkdir(instance, { recursive: true });

      const resolved = await myGamesResolver(instance, detectors(), 'linux')('Fallout4');

      expect(resolved).toEqual({ kind: 'found', folder: expected });
    });

    it('names every place it looked when none resolves', async () => {
      const prefix = join(base, 'compatdata', '377160', 'pfx');
      await mkdir(prefixDocuments(prefix, 'steamuser'), { recursive: true });

      const resolved = await myGamesResolver(join(base, 'MO2'), detectors({ winePrefix: () => Promise.resolve(prefix) }), 'linux')('Fallout4');

      expect(resolved).toEqual({
        kind: 'notFound',
        looked: [
          `the Steam prefix of app 377160, ${prefix}: no My Games/Fallout4 folder in its Documents`,
          `the Wine prefix holding the instance: ${join(base, 'MO2')} is under no drive_c`,
        ],
      });
    });

    it('does not ask Steam for a release with no app id', async () => {
      const resolved = await myGamesResolver(base, detectors({ winePrefix: () => Promise.reject(new Error('asked')) }), 'linux')('SkyrimSE');

      expect(resolved).toEqual({
        kind: 'notFound',
        looked: [
          'the Steam prefix: Modbench has no Steam entry for this game',
          `the Wine prefix holding the instance: ${base} is under no drive_c`,
        ],
      });
    });

    it('looks nowhere for a release the tables hold no row for', async () => {
      expect(await myGamesResolver(base, detectors(), 'linux')(undefined)).toEqual({ kind: 'notFound', looked: [] });
    });
  });
});
