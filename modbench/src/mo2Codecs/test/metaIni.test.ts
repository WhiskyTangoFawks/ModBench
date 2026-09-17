import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMetaIni, writeMetaIni, setOwnedKeysInText } from '../metaIni';

const modsDir = join(__dirname, '..', '..', 'modmanager', 'test', 'fixtures', 'mo2-instance', 'mods');
const meta = (mod: string) => readFileSync(join(modsDir, mod, 'meta.ini'), 'utf8');

describe('parseMetaIni', () => {
  it('reads version, nexusId (modid) and archiveFilename (installationFile)', () => {
    expect(parseMetaIni(meta('Unofficial Fallout 4 Patch'))).toEqual({
      version: '2.1.5.0',
      nexusId: '4598',
      archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
  });

  it('treats modid=0 and empty fields as undefined, not empty strings', () => {
    expect(parseMetaIni(meta('ENBoost - 12k'))).toEqual({
      version: undefined,
      nexusId: undefined,
      archiveFilename: undefined,
    });
  });

  it('returns all-undefined for content missing the keys entirely', () => {
    expect(parseMetaIni('[General]\r\ngameName=Fallout4\r\n')).toEqual({
      version: undefined,
      nexusId: undefined,
      archiveFilename: undefined,
    });
  });

  it('does not let a line lacking "=" corrupt the parsed fields', () => {
    // The decoy is chosen so that a slice(0, -1) off the missing "=" would land on
    // exactly "installationFile".
    expect(parseMetaIni('[General]\r\ninstallationFilex\r\nversion=1.0\r\n')).toEqual({
      version: '1.0',
      nexusId: undefined,
      archiveFilename: undefined,
    });
  });
});

describe('parseMetaIni — installedFiles', () => {
  it('reads two installed-files pairs from the array section, in index order', () => {
    const text = [
      '[General]', 'gameName=Fallout4', 'modid=4598',
      '[installedFiles]',
      '1\\modid=4598', '1\\fileid=17423',
      '2\\modid=4598', '2\\fileid=17500',
      'size=2', '',
    ].join('\r\n');
    expect(parseMetaIni(text).installedFiles).toEqual([
      { modid: '4598', fileid: '17423' },
      { modid: '4598', fileid: '17500' },
    ]);
  });

  it('is undefined when the section is absent', () => {
    expect(parseMetaIni('[General]\r\ngameName=Fallout4\r\n').installedFiles).toBeUndefined();
  });

  // Mirrors houseCARL's Mo2ModMeta guard: a FOMOD/manual install has size=0 and no
  // fileid, and a fileid living in another section must never leak in.
  it('is undefined for size=0 with no pairs, and ignores a fileid outside the section', () => {
    const text = [
      '[General]', 'modid=1',
      '[installedFiles]', 'size=0',
      '[Plugins]', '1\\fileid=999', '',
    ].join('\r\n');
    expect(parseMetaIni(text).installedFiles).toBeUndefined();
  });

  // Real MO2 files interleave size= between entries and do not guarantee index order
  // (AMON's live file puts size= between 1\modid and 1\fileid) — the parser is scoped
  // to the section and keyed by index, not by line position.
  it('tolerates out-of-order indices and an interleaved size key', () => {
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
      { modid: '126608', fileid: '111' },
      { modid: '126608', fileid: '222' },
    ]);
  });
});

describe('writeMetaIni', () => {
  it('emits a [General] section with only the present keys', () => {
    expect(writeMetaIni({ gameName: 'Fallout4', installationFile: 'MyMod-1-2.7z' })).toBe(
      '[General]\ngameName=Fallout4\ninstallationFile=MyMod-1-2.7z\n',
    );
  });

  it('omits absent keys entirely (no blank lines)', () => {
    expect(writeMetaIni({ gameName: 'Fallout4' })).toBe('[General]\ngameName=Fallout4\n');
  });

  it('round-trips modid/version/installationFile through parseMetaIni', () => {
    const text = writeMetaIni({
      gameName: 'Fallout4',
      modid: '4598',
      version: '2.1.5.0',
      installationFile: 'UFO4P-4598.7z',
    });
    expect(parseMetaIni(text)).toEqual({
      version: '2.1.5.0',
      nexusId: '4598',
      archiveFilename: 'UFO4P-4598.7z',
    });
  });
});

describe('writeMetaIni — installedFiles', () => {
  it('emits the array section whole, in MO2 form, after [General]', () => {
    expect(writeMetaIni({ installedFiles: [{ modid: '123', fileid: '456' }] })).toBe(
      '[General]\n[installedFiles]\n1\\modid=123\n1\\fileid=456\nsize=1\n',
    );
  });

  it('emits every pair, indexed from 1, with size last', () => {
    expect(
      writeMetaIni({
        installedFiles: [
          { modid: '4598', fileid: '17423' },
          { modid: '4598', fileid: '17500' },
        ],
      }),
    ).toBe('[General]\n[installedFiles]\n1\\modid=4598\n1\\fileid=17423\n2\\modid=4598\n2\\fileid=17500\nsize=2\n');
  });

  it('omits the section entirely when installedFiles is absent or empty', () => {
    expect(writeMetaIni({ gameName: 'Fallout4' })).toBe('[General]\ngameName=Fallout4\n');
    expect(writeMetaIni({ gameName: 'Fallout4', installedFiles: [] })).toBe('[General]\ngameName=Fallout4\n');
  });

  it('round-trips two pairs through parseMetaIni byte-identical in the [installedFiles] section', () => {
    const written = writeMetaIni({
      gameName: 'Fallout4',
      modid: '4598',
      installedFiles: [
        { modid: '4598', fileid: '17423' },
        { modid: '4598', fileid: '17500' },
      ],
    });
    const parsed = parseMetaIni(written);
    const rewritten = writeMetaIni({ gameName: 'Fallout4', modid: '4598', installedFiles: parsed.installedFiles });
    expect(rewritten.slice(rewritten.indexOf('[installedFiles]'))).toBe(
      written.slice(written.indexOf('[installedFiles]')),
    );
  });
});

describe('setOwnedKeysInText', () => {
  it('over empty text produces exactly what the plain writer produces', () => {
    const keys = {
      gameName: 'Fallout4',
      modid: '4598',
      version: '2.0',
      installationFile: 'Mod-4598.7z',
      installedFiles: [{ modid: '4598', fileid: '17423' }],
    };
    expect(setOwnedKeysInText('', keys)).toBe(writeMetaIni(keys));
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
      modid: '4598',
      version: '2.0.0',
      installationFile: 'New-4598.7z',
      installedFiles: [{ modid: '4598', fileid: '99999' }],
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

  it('adds a missing owned key right after the header, leaving unrelated General keys and later sections untouched', () => {
    const text = '[General]\r\ncategory="-1,"\r\n[Plugins]\r\nFoo.esp\\enabled=true\r\n';
    const result = setOwnedKeysInText(text, { modid: '4598' });
    expect(result).toBe('[General]\r\nmodid=4598\r\ncategory="-1,"\r\n[Plugins]\r\nFoo.esp\\enabled=true\r\n');
  });

  it('adds a fresh [installedFiles] section at the end when the source meta.ini has none', () => {
    const text = '[General]\r\ngameName=Fallout4\r\n';
    const result = setOwnedKeysInText(text, {
      gameName: 'Fallout4',
      installedFiles: [{ modid: '4598', fileid: '17423' }],
    });
    expect(result).toBe('[General]\r\ngameName=Fallout4\r\n[installedFiles]\r\n1\\modid=4598\r\n1\\fileid=17423\r\nsize=1\r\n');
  });

  // Owned means fully owned: an owned key absent from the call is cleared from
  // existing text, not left behind — the caller states the whole target state.
  it('clears an owned key that the call omits, even if it was present before', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=4598\r\n';
    const result = setOwnedKeysInText(text, { gameName: 'Fallout4' });
    expect(result).toBe('[General]\r\ngameName=Fallout4\r\n');
  });

  it('creates a fresh [General] section ahead of everything when the source has none', () => {
    const text = '[Plugins]\r\nFoo.esp\\enabled=true\r\n';
    const result = setOwnedKeysInText(text, { gameName: 'Fallout4' });
    expect(result).toBe('[General]\r\ngameName=Fallout4\r\n[Plugins]\r\nFoo.esp\\enabled=true\r\n');
  });
});
