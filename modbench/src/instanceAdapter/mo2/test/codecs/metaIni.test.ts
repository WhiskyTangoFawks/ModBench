import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modMetaOf, parseMetaIni, writeMetaIni, setOwnedKeysInText } from '../../codecs/metaIni';

const modsDir = join(__dirname, '..', '..', '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance', 'mods');
const meta = (mod: string) => readFileSync(join(modsDir, mod, 'meta.ini'), 'utf8');

describe('a mod\'s meta.ini read', () => {
  it('reads version, nexusId (modid) and installationFileName (installationFile)', () => {
    expect(parseMetaIni(meta('Unofficial Fallout 4 Patch'))).toEqual({
      gameName: 'Fallout4',
      version: '2.1.5.0',
      nexusId: '4598',
      installationFileName: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
  });

  it('treats modid=-1, MO2\'s default, as no Nexus id', () => {
    expect(parseMetaIni('[General]\r\nmodid=-1\r\n').nexusId).toBeUndefined();
  });

  it('treats modid=0 and empty fields as undefined, not empty strings', () => {
    expect(parseMetaIni(meta('ENBoost - 12k'))).toEqual({
      gameName: 'Fallout4',
      version: undefined,
      nexusId: undefined,
      installationFileName: undefined,
    });
  });

  it('reads only the game of content missing the other keys', () => {
    expect(parseMetaIni('[General]\r\ngameName=Fallout4\r\n')).toEqual({
      gameName: 'Fallout4',
      version: undefined,
      nexusId: undefined,
      installationFileName: undefined,
    });
  });

});

describe('whether a mod\'s update is available', () => {
  it.each([
    ['1.0', '1.1', true],
    ['1.1', '1.1', false],
    ['1.0', '', false],
  ])('a mod at %s with newestVersion %s has updateAvailable %s', (version, newestVersion, updateAvailable) => {
    expect(modMetaOf(parseMetaIni(`[General]\r\nversion=${version}\r\nnewestVersion=${newestVersion}\r\n`)).updateAvailable).toBe(updateAvailable);
  });
});

describe('a mod\'s meta.ini read by section', () => {
  it('reads [General] keys only, not the same key in another section', () => {
    expect(parseMetaIni('[Plugins]\r\nversion=9\r\n[General]\r\nversion=1\r\n').version).toBe('1');
  });
});

describe('the installed files a mod\'s meta.ini holds', () => {
  it('reads two installed-files pairs from the array section, in index order', () => {
    const text = [
      '[General]', 'gameName=Fallout4', 'modid=4598',
      '[installedFiles]',
      '1\\modid=4598', '1\\fileid=17423',
      '2\\modid=4598', '2\\fileid=17500',
      'size=2', '',
    ].join('\r\n');
    expect(parseMetaIni(text).installedFiles).toEqual([
      { nexusId: '4598', fileId: '17423' },
      { nexusId: '4598', fileId: '17500' },
    ]);
  });

  it('is undefined when the section is absent', () => {
    expect(parseMetaIni('[General]\r\ngameName=Fallout4\r\n').installedFiles).toBeUndefined();
  });

  it('is undefined for size=0 with no pairs, and ignores a fileid outside the section, mirroring houseCARL\'s Mo2ModMeta guard for a FOMOD/manual install with size=0 and no fileid', () => {
    const text = [
      '[General]', 'modid=1',
      '[installedFiles]', 'size=0',
      '[Plugins]', '1\\fileid=999', '',
    ].join('\r\n');
    expect(parseMetaIni(text).installedFiles).toBeUndefined();
  });

  it('tolerates out-of-order indices and an interleaved size key, as real MO2 files interleave size= between entries (AMON\'s puts it between 1\\modid and 1\\fileid) and the parser keys by index within the section, not by line position', () => {
    const text = [
      '[General]', 'modid=126608',
      '[installedFiles]',
      '2\\fileid=222',
      '1\\modid=126608',
      'size=2',
      '2\\modid=126608',
      '1\\fileid=111', '',
    ].join('\r\n');
    expect(parseMetaIni(text).installedFiles).toEqual([
      { nexusId: '126608', fileId: '111' },
      { nexusId: '126608', fileId: '222' },
    ]);
  });
});

describe('a mod\'s meta.ini written', () => {
  it('emits a [General] section with only the present keys', () => {
    expect(writeMetaIni({ gameName: 'Fallout4', installationFileName: 'MyMod-1-2.7z' })).toBe(
      '[General]\ngameName=Fallout4\ninstallationFile=MyMod-1-2.7z\n',
    );
  });

  it('round-trips modid/version/installationFile through parseMetaIni', () => {
    const text = writeMetaIni({
      gameName: 'Fallout4',
      nexusId: '4598',
      version: '2.1.5.0',
      installationFileName: 'UFO4P-4598.7z',
    });
    expect(parseMetaIni(text)).toEqual({
      gameName: 'Fallout4',
      version: '2.1.5.0',
      nexusId: '4598',
      installationFileName: 'UFO4P-4598.7z',
    });
  });
});

describe('the installed files written to a mod\'s meta.ini', () => {
  it('emits the array section whole, in MO2 form', () => {
    expect(writeMetaIni({ installedFiles: [{ nexusId: '123', fileId: '456' }] })).toBe(
      '[installedFiles]\n1\\modid=123\n1\\fileid=456\nsize=1\n',
    );
  });

  it('emits every pair, indexed from 1, with size last', () => {
    expect(
      writeMetaIni({
        installedFiles: [
          { nexusId: '4598', fileId: '17423' },
          { nexusId: '4598', fileId: '17500' },
        ],
      }),
    ).toBe('[installedFiles]\n1\\modid=4598\n1\\fileid=17423\n2\\modid=4598\n2\\fileid=17500\nsize=2\n');
  });

  it('omits the section entirely when installedFiles is absent or empty', () => {
    expect(writeMetaIni({ gameName: 'Fallout4' })).toBe('[General]\ngameName=Fallout4\n');
    expect(writeMetaIni({ gameName: 'Fallout4', installedFiles: [] })).toBe('[General]\ngameName=Fallout4\n');
  });

  it('round-trips two pairs through parseMetaIni byte-identical in the [installedFiles] section', () => {
    const written = writeMetaIni({
      gameName: 'Fallout4',
      nexusId: '4598',
      installedFiles: [
        { nexusId: '4598', fileId: '17423' },
        { nexusId: '4598', fileId: '17500' },
      ],
    });
    const parsed = parseMetaIni(written);
    const rewritten = writeMetaIni({ gameName: 'Fallout4', nexusId: '4598', installedFiles: parsed.installedFiles });
    expect(rewritten.slice(rewritten.indexOf('[installedFiles]'))).toBe(
      written.slice(written.indexOf('[installedFiles]')),
    );
  });
});

describe('the keys Modbench owns set in a mod\'s meta.ini', () => {
  it.each([
    ['a quoted value', 'installationFile="Mod, v2.7z"'],
    ['an escaped backslash', 'installationFile=C:\\\\x.7z'],
  ])('writes back %s a carried parse read, byte for byte', (_name, line) => {
    const text = `[General]\r\ngameName=Fallout4\r\n${line}\r\n`;
    expect(setOwnedKeysInText(text, { ...parseMetaIni(text), gameName: 'Fallout4' })).toBe(text);
  });

  it('writes an owned key given empty as `key=`, not as a deletion', () => {
    expect(setOwnedKeysInText('[General]\r\nversion=1\r\n', { version: '' })).toBe('[General]\r\nversion=\r\n');
  });

  it('replaces only the owned keys, preserving unknown General keys, other sections and re-emitting installedFiles whole', () => {
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

    const result = setOwnedKeysInText(text, {
      gameName: 'Fallout4',
      nexusId: '4598',
      version: '2.0.0',
      installationFileName: 'New-4598.7z',
      installedFiles: [{ nexusId: '4598', fileId: '99999' }],
    });

    expect(result).toBe(
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

  it('clears an owned key that the call omits, even if it was present before, the caller stating the whole target state', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=4598\r\n';
    const result = setOwnedKeysInText(text, { gameName: 'Fallout4' });
    expect(result).toBe('[General]\r\ngameName=Fallout4\r\n');
  });

});
