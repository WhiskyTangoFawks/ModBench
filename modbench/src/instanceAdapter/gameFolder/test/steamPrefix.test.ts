import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nonSteamPrefixRunning } from '../steamPrefix';

const binaryText = (key: string, value: string): Buffer => Buffer.concat([Buffer.from([1]), Buffer.from(`${key}\0${value}\0`)]);
const binaryUint = (key: string, value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return Buffer.concat([Buffer.from([2]), Buffer.from(`${key}\0`), bytes]);
};

interface Entry {
  readonly appid?: number;
  readonly exe: string;
}

const shortcutsFile = (entries: readonly Entry[]): Buffer => Buffer.concat([
  Buffer.from('\0shortcuts\0'),
  ...entries.flatMap(({ appid, exe }, n) => [
    Buffer.from(`\0${n}\0`), ...(appid === undefined ? [] : [binaryUint('appid', appid)]), binaryText('AppName', 'Fallout 4'), binaryText('Exe', exe), Buffer.from([8]),
  ]),
  Buffer.from([8, 8]),
]);

const APP_ID = 3_000_000_001;

describe('the prefix of the non-Steam game that runs a program in a folder', () => {
  let root: string;
  let steam: string;
  let deployment: string;
  const prefixIn = (library: string) => join(library, 'steamapps', 'compatdata', String(APP_ID), 'pfx');
  const shortcutsOf = async (user: string, entries: readonly Entry[]) => {
    await mkdir(join(steam, 'userdata', user, 'config'), { recursive: true });
    await writeFile(join(steam, 'userdata', user, 'config', 'shortcuts.vdf'), shortcutsFile(entries));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'prefix-'));
    steam = join(root, 'steam');
    deployment = join(root, 'deployments', 'survival');
    await mkdir(deployment, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('is the prefix in Steam\'s root, found by a program in the folder, quoted as Steam writes it', async () => {
    await shortcutsOf('1', [{ appid: 7, exe: '"/elsewhere/f4se_loader.exe"' }, { appid: APP_ID, exe: `"${join(deployment, 'f4se_loader.exe')}"` }]);
    await mkdir(prefixIn(steam), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ prefix: prefixIn(steam) });
  });

  it('finds the shortcut in any Steam user\'s file', async () => {
    await shortcutsOf('1', []);
    await shortcutsOf('2', [{ appid: APP_ID, exe: join(deployment, 'Fallout4.exe') }]);
    await mkdir(prefixIn(steam), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ prefix: prefixIn(steam) });
  });

  it('finds the prefix in another Steam library its libraryfolders.vdf names', async () => {
    const library = join(root, 'library');
    await mkdir(join(steam, 'config'), { recursive: true });
    await writeFile(join(steam, 'config', 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${library}"\n\t}\n}\n`);
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, 'f4se_loader.exe') }]);
    await mkdir(prefixIn(library), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ prefix: prefixIn(library) });
  });

  it('is none, and says so, when no Steam is known', async () => {
    expect(await nonSteamPrefixRunning(undefined, deployment)).toEqual({ why: 'Modbench found no Steam' });
  });

  it('is none when Steam holds no shortcuts', async () => {
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `no non-Steam game in Steam runs a program in ${deployment}` });
  });

  it('is none when no non-Steam game runs a program in the folder', async () => {
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, '..', 'other', 'f4se_loader.exe') }]);
    await mkdir(prefixIn(steam), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `no non-Steam game in Steam runs a program in ${deployment}` });
  });

  it('is none, and names the shortcut, when the one that runs a program in the folder holds no appid', async () => {
    const exe = join(deployment, 'f4se_loader.exe');
    await shortcutsOf('1', [{ exe }]);
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `Steam's shortcut for ${exe} holds no appid` });
  });

  it('is none when the game has no prefix yet', async () => {
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, 'f4se_loader.exe') }]);
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `Steam has made no prefix at ${prefixIn(steam)} yet` });
  });
});
