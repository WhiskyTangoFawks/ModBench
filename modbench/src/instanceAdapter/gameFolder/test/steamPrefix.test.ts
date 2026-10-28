import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  it.each([
    ['no Steam is looked for', undefined, 'Modbench looks for no Steam on this platform'],
    ['the Steam root is not there', '/nowhere/steam', 'Modbench found no Steam at /nowhere/steam'],
  ])('is none, and says so, when %s', async (_case, steamRoot, why) => {
    expect(await nonSteamPrefixRunning(steamRoot, deployment)).toEqual({ why });
  });

  it('is none when Steam holds no shortcuts, or none runs a program in the folder', async () => {
    await mkdir(steam, { recursive: true });
    const none = { why: `no non-Steam game in Steam runs a program in ${deployment}` };
    const noShortcuts = await nonSteamPrefixRunning(steam, deployment);
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, '..', 'other', 'f4se_loader.exe') }]);
    await mkdir(prefixIn(steam), { recursive: true });

    expect([noShortcuts, await nonSteamPrefixRunning(steam, deployment)]).toEqual([none, none]);
  });

  it('finds the program by the real path of the folder, through a link', async () => {
    const link = join(root, 'link-to-deployment');
    await symlink(deployment, link);
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(link, 'f4se_loader.exe') }]);
    await mkdir(prefixIn(steam), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ prefix: prefixIn(steam) });
  });

  it('is none, and names the shortcut, when the one that runs a program in the folder holds no appid', async () => {
    const exe = join(deployment, 'f4se_loader.exe');
    await shortcutsOf('1', [{ exe }]);
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `Steam's shortcut for ${exe} holds no appid` });
  });

  it('is none, and names each, when several non-Steam games run programs in the folder', async () => {
    const first = join(deployment, 'f4se_loader.exe');
    const second = join(deployment, 'Fallout4.exe');
    await shortcutsOf('1', [{ appid: APP_ID, exe: first }, { appid: APP_ID + 1, exe: second }]);
    await mkdir(prefixIn(steam), { recursive: true });
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `several non-Steam games in Steam run programs in ${deployment}: ${first}, ${second}` });
  });

  it('is none when the game has no prefix yet', async () => {
    await shortcutsOf('1', [{ appid: APP_ID, exe: join(deployment, 'f4se_loader.exe') }]);
    expect(await nonSteamPrefixRunning(steam, deployment)).toEqual({ why: `Steam has made no prefix at ${prefixIn(steam)} yet` });
  });

  describe('when a file of Steam\'s cannot be read', () => {
    const exe = () => join(deployment, 'f4se_loader.exe');
    const whyOf = (answer: Awaited<ReturnType<typeof nonSteamPrefixRunning>>): string => ('why' in answer ? answer.why : `prefix ${answer.prefix}`);
    const shortcutsPath = () => join(steam, 'userdata', '1', 'config', 'shortcuts.vdf');

    it.each([
      ['truncated', (file: Buffer) => file.subarray(0, file.length - 3), /ends inside/],
      ['corrupt', () => Buffer.from('\0shortcuts\0\u0007x\0', 'latin1'), /unknown tag 7/],
    ])('is none, and says why, when shortcuts.vdf is %s', async (_case, damage, reason) => {
      await shortcutsOf('1', [{ appid: APP_ID, exe: exe() }]);
      await writeFile(shortcutsPath(), damage(shortcutsFile([{ appid: APP_ID, exe: exe() }])));
      expect(whyOf(await nonSteamPrefixRunning(steam, deployment))).toMatch(new RegExp(`^Steam cannot be read: ${shortcutsPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*${reason.source}`));
    });

    it('is none, and says why, when shortcuts.vdf is not a file', async () => {
      await mkdir(shortcutsPath(), { recursive: true });
      expect(whyOf(await nonSteamPrefixRunning(steam, deployment))).toMatch(/^Steam cannot be read: .*EISDIR/);
    });

    it('is none, and says why, when a plain file sits in userdata, which is not a Steam user', async () => {
      await mkdir(join(steam, 'userdata'), { recursive: true });
      await writeFile(join(steam, 'userdata', 'stray'), 'x');
      expect(whyOf(await nonSteamPrefixRunning(steam, deployment))).toMatch(/^no non-Steam game/);
    });

    it('is none, and says why, when libraryfolders.vdf is not a file', async () => {
      await shortcutsOf('1', [{ appid: APP_ID, exe: exe() }]);
      await mkdir(join(steam, 'config', 'libraryfolders.vdf'), { recursive: true });
      expect(whyOf(await nonSteamPrefixRunning(steam, deployment))).toMatch(/^Steam cannot be read: .*EISDIR/);
    });
  });
});
