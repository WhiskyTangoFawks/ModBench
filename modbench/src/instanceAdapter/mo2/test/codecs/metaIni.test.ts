import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import type { InstalledPackage, Mod } from '../../../instanceAdapter';
import { mo2InstanceHolding, type HeldInstance } from '../../../test/mo2InstanceHolding';

vi.mock('vscode', () => fakeVscodeModule());

const modsDir = join(__dirname, '..', '..', '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance', 'mods');
const fixtureMeta = (mod: string) => readFileSync(join(modsDir, mod, 'meta.ini'), 'utf8');

const META = 'mods/M/meta.ini';
const trash = (path: string): Promise<void> => rm(path);

type Package = InstalledPackage & { readonly meta?: string };

const modHolding = (files: Readonly<Record<string, string>>): HeldInstance =>
  mo2InstanceHolding({ 'profiles/Default/modlist.txt': '+M\r\n', ...files });

async function modRead(meta: string): Promise<Mod | undefined> {
  return (await modHolding({ [META]: meta }).adapter.reading()).mods.find((entry): entry is Mod => entry.kind === 'mod');
}

const installFrom = (instance: HeldInstance, packages: readonly Package[]): Promise<void> =>
  instance.adapter.writeInstalledFrom(join(instance.root, 'mods', 'M'), packages.map(({ name, version }) => ({ name, version })), trash);

async function installedFrom(carried: string | undefined, packages: readonly Package[]): Promise<HeldInstance> {
  const downloads = Object.fromEntries(packages.flatMap(({ name, meta }) => (meta === undefined ? [] : [[`downloads/${name}`, 'bytes'], [`downloads/${name}.meta`, meta]])));
  const instance = modHolding({ ...downloads, ...carried === undefined ? { 'mods/M/x.esp': '' } : { [META]: carried } });
  await installFrom(instance, packages);
  return instance;
}

const writtenFrom = async (carried: string | undefined, packages: readonly Package[]): Promise<string> =>
  (await installedFrom(carried, packages)).text(META);

describe('a mod\'s meta.ini read', () => {
  it('reads version, nexusId (modid) and installationFileName (installationFile)', async () => {
    expect(await modRead(fixtureMeta('Unofficial Fallout 4 Patch'))).toMatchObject({
      gameName: 'Fallout4',
      version: '2.1.5.0',
      nexusId: '4598',
      installationFileName: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
  });

  it('treats modid=-1, MO2\'s default, as no Nexus id', async () => {
    expect((await modRead('[General]\r\nmodid=-1\r\n'))?.nexusId).toBeUndefined();
  });

  it('treats modid=0 and empty fields as undefined, not empty strings', async () => {
    expect(await modRead(fixtureMeta('ENBoost - 12k'))).toEqual({
      kind: 'mod', name: 'M', enabled: true, gameName: 'Fallout4', updateAvailable: false,
    });
  });

  it('reads only the game of content missing the other keys', async () => {
    expect(await modRead('[General]\r\ngameName=Fallout4\r\n')).toEqual({
      kind: 'mod', name: 'M', enabled: true, gameName: 'Fallout4', updateAvailable: false,
    });
  });
});

describe('whether a mod\'s update is available', () => {
  it.each([
    ['1.0', '1.1', true],
    ['1.1', '1.1', false],
    ['1.0', '', false],
  ])('a mod at %s with newestVersion %s has updateAvailable %s', async (version, newestVersion, updateAvailable) => {
    expect((await modRead(`[General]\r\nversion=${version}\r\nnewestVersion=${newestVersion}\r\n`))?.updateAvailable).toBe(updateAvailable);
  });
});

describe('the installed files a mod\'s meta.ini holds', () => {
  it.each([
    ['reads two installed-files pairs from the array section, in index order', [
      '[General]', 'gameName=Fallout4', 'modid=4598',
      '[installedFiles]',
      '1\\modid=4598', '1\\fileid=17423',
      '2\\modid=4598', '2\\fileid=17500',
      'size=2', '',
    ], ['4598:17423', '4598:17500']],
    ['is undefined when the section is absent', ['[General]', 'gameName=Fallout4', ''], undefined],
    ['is undefined for size=0 with no pairs, and ignores a fileid outside the section, mirroring houseCARL\'s Mo2ModMeta guard for a FOMOD/manual install with size=0 and no fileid', [
      '[General]', 'modid=1',
      '[installedFiles]', 'size=0',
      '[Plugins]', '1\\fileid=999', '',
    ], undefined],
    ['tolerates out-of-order indices and an interleaved size key, as real MO2 files interleave size= between entries (AMON\'s puts it between 1\\modid and 1\\fileid) and the parser keys by index within the section, not by line position', [
      '[General]', 'modid=126608',
      '[installedFiles]',
      '2\\fileid=222',
      '1\\modid=126608',
      'size=2',
      '2\\modid=126608',
      '1\\fileid=111', '',
    ], ['126608:111', '126608:222']],
  ])('%s', async (_, lines, keys) => {
    expect((await modRead(lines.join('\r\n')))?.installedFileKeys).toEqual(keys);
  });
});

describe('a mod\'s meta.ini written', () => {
  it('emits a [General] section with only the present keys', async () => {
    expect(await writtenFrom(undefined, [{ name: 'MyMod-1-2.7z' }])).toBe('[General]\ngameName=Fallout4\ninstallationFile=MyMod-1-2.7z\n');
  });

  it('round-trips modid/version/installationFile through parseMetaIni', async () => {
    const { adapter } = await installedFrom(undefined, [{ name: 'UFO4P-4598-2-1.7z', version: '2.1.5.0' }]);

    expect((await adapter.reading()).mods.find((entry) => entry.kind === 'mod')).toMatchObject({
      gameName: 'Fallout4',
      version: '2.1.5.0',
      nexusId: '4598',
      installationFileName: 'UFO4P-4598-2-1.7z',
    });
  });
});

describe('the installed files written to a mod\'s meta.ini', () => {
  it('emits the array section whole, in MO2 form', async () => {
    expect(await writtenFrom(undefined, [{ name: 'P.7z', meta: '[General]\nmodID=123\nfileID=456\n' }]))
      .toBe('[General]\ngameName=Fallout4\nmodid=123\ninstallationFile=P.7z\n[installedFiles]\n1\\modid=123\n1\\fileid=456\nsize=1\n');
  });

  const TWO_PACKAGES = [{ name: 'P.7z', meta: '[General]\nmodID=4598\nfileID=17423\n' }, { name: 'Q.7z', meta: '[General]\nmodID=4598\nfileID=17500\n' }];

  it('emits every pair, indexed from 1, with size last', async () => {
    expect(await writtenFrom(undefined, TWO_PACKAGES))
      .toMatch(/\[installedFiles\]\n1\\modid=4598\n1\\fileid=17423\n2\\modid=4598\n2\\fileid=17500\nsize=2\n$/);
  });

  it('round-trips two pairs through parseMetaIni byte-identical in the [installedFiles] section', async () => {
    const instance = await installedFrom(undefined, TWO_PACKAGES);
    const written = await instance.text(META);

    await installFrom(instance, TWO_PACKAGES);

    expect(await instance.text(META)).toBe(written);
  });
});

describe('the keys Modbench owns set in a mod\'s meta.ini', () => {
  it.each([
    ['a quoted value', 'version="Mod, v2"'],
    ['an escaped backslash', 'version=C:\\\\x'],
  ])('writes back %s a carried parse read, byte for byte', async (_name, line) => {
    const text = `[General]\r\ngameName=Fallout4\r\n${line}\r\ninstallationFile=P.7z\r\n`;
    expect(await writtenFrom(text, [{ name: 'P.7z' }])).toBe(text);
  });

  it('replaces only the owned keys, preserving unknown General keys, other sections and re-emitting installedFiles whole', async () => {
    const text = [
      '[General]',
      'gameName=Fallout4',
      'modid=4598',
      'version=1.0.0',
      'category="-1,"',
      'installationFile=Old-4598.7z',
      '[installedFiles]',
      '1\\modid=4598',
      '1\\fileid=17423',
      'size=1',
      '[Plugins]',
      'SomePlugin.esp\\enabled=true',
      '',
    ].join('\r\n');

    expect(await writtenFrom(text, [{ name: 'New-4598.7z', version: '2.0.0', meta: '[General]\nmodID=4598\nfileID=99999\n' }])).toBe(
      [
        '[General]',
        'gameName=Fallout4',
        'modid=4598',
        'version=2.0.0',
        'category="-1,"',
        'installationFile=New-4598.7z',
        '[installedFiles]',
        '1\\modid=4598',
        '1\\fileid=99999',
        'size=1',
        '[Plugins]',
        'SomePlugin.esp\\enabled=true',
        '',
      ].join('\r\n'),
    );
  });
});
