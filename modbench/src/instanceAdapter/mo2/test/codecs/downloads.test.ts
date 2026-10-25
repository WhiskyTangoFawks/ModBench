import { describe, it, expect } from 'vitest';
import {
  parseDownloadedFileMeta,
  setNexusFileInfoInText,
  setHiddenInText,
  setInstalledInText,
  setUninstalledInText,
} from '../../codecs/downloads';

const metaOf = (text: string) => parseDownloadedFileMeta(text).meta;

describe('a downloaded file\'s status read from its .meta', () => {
  it('uninstalled=true -> Uninstalled status', () => {
    expect(metaOf('[General]\r\nuninstalled=true\r\n').status).toBe('Uninstalled');
  });

  it('reads the tooltip fields: modName, gameName, author', () => {
    const meta = metaOf('[General]\r\nmodName=Sleep or Save\r\ngameName=Fallout4\r\nauthor=SomeAuthor\r\n');
    expect(meta.modName).toBe('Sleep or Save');
    expect(meta.gameName).toBe('Fallout4');
    expect(meta.author).toBe('SomeAuthor');
  });

  it('treats modID=0 as no id, same as an absent modID (Visit-on-Nexus gated off)', () => {
    expect(metaOf('[General]\r\nmodID=0\r\n').modID).toBeUndefined();
  });

  it.each([
    ['[General]\r\nfileCategory=3\r\n', 3],
    ['[General]\r\nfileCategory=abc\r\n', 0],
    ['[General]\r\nfileCategory=0x10\r\n', 0],
    ['[General]\r\n', undefined],
  ])('reads the file category of %j as %s', (text, expected) => {
    expect(metaOf(text).fileCategory).toBe(expected);
  });

  it('keys the installed file by its mod and file ids, and by nothing when either is absent', () => {
    expect(metaOf('[General]\r\nmodID=9\r\nfileID=78\r\n').installedKey).toBe('9:78');
    expect(metaOf('[General]\r\nmodID=9\r\n').installedKey).toBeUndefined();
  });

  it('reads the file ID, and reads 0 as none', () => {
    expect(metaOf('[General]\r\nfileID=78\r\n').fileID).toBe('78');
    expect(metaOf('[General]\r\nfileID=0\r\n').fileID).toBeUndefined();
  });

  it('treats fileID=0 as no id, same as an absent fileID', () => {
    expect(metaOf('[General]\r\nmodID=9\r\nfileID=0\r\n').installedKey).toBeUndefined();
  });

  it('parses a hand-edited .meta with padded key=value spacing, which a writer never would, the same as the tight form', () => {
    const tight = metaOf('[General]\r\nmodID=12345\r\n');
    const padded = metaOf('[General]\r\nmodID = 12345\r\n');
    expect(padded.modID).toBe('12345');
    expect(padded).toEqual(tight);
  });
});

describe('whether a downloaded file\'s .meta hides it', () => {
  it('is false when removed is explicitly false', () => {
    expect(parseDownloadedFileMeta('[General]\r\nremoved=false\r\n').hidden).toBe(false);
  });

  it('is independent of the Uninstalled Status: both keys coexist', () => {
    const parsed = parseDownloadedFileMeta('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect(parsed.meta.status).toBe('Uninstalled');
    expect(parsed.hidden).toBe(true);
  });
});

describe('the values a downloaded file\'s .meta holds', () => {
  it('are decoded, as MO2 writes a name holding a comma quoted', () => {
    expect(metaOf('[General]\r\nmodName="A, B"\r\n').modName).toBe('A, B');
  });
});

describe('a downloaded file hidden or shown in its .meta', () => {
  it('creates a fresh [General] section with removed=true when there is no .meta text', () => {
    expect(setHiddenInText('', true)).toBe('[General]\r\nremoved=true\r\n');
  });

  it('flips removed=true to false in place when unhiding as MO2 does, writing removed=false rather than deleting the key, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nremoved=true\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, false)).toBe(
      '[General]\r\ngameName=Fallout4\r\nremoved=false\r\nmodid=12345\r\n',
    );
  });
});

describe('a downloaded file marked installed in its .meta', () => {
  it('creates a fresh [General] section with both keys when there is no .meta text', () => {
    expect(setInstalledInText('')).toBe('[General]\r\ninstalled=true\r\nuninstalled=false\r\n');
  });

  it('clears an earlier uninstall, so a reinstalled downloaded file reads Installed again, MO2\'s markInstalled writing uninstalled=false beside installed=true and a reader taking uninstalled first', () => {
    const uninstalled = setUninstalledInText('[General]\r\ninstalled=true\r\n');
    expect(metaOf(uninstalled).status).toBe('Uninstalled');
    expect(metaOf(setInstalledInText(uninstalled)).status).toBe('Installed');
  });

});

describe('a downloaded file marked uninstalled in its .meta', () => {
  it('leaves installed=true in place — it is a separate key, never cleared, as MO2 writes uninstalled=true on uninstall without clearing installed', () => {
    const text = '[General]\r\ninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });
});

describe('the Nexus file info written to a downloaded file\'s .meta', () => {
  const info = {
    game: 'fallout4', modID: '4598', fileID: '78', name: 'Main', version: '2.1.5', fileCategory: 1, modName: 'Patch', category: 12,
    author: 'Team', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1', description: '[b]Fixes[/b]',
  };

  it('writes the keys in the order MO2 writes them, the description as HTML and the version canonical', () => {
    expect(setNexusFileInfoInText('', info, 'Fallout4')).toBe([
      '[General]', 'gameName=Fallout4', 'modID=4598', 'fileID=78', 'name=Main', 'description=<b>Fixes</b>', 'modName=Patch',
      'version=2.1.5.0', 'fileCategory=1', 'category=12', 'author=Team', 'uploader=Uploader', 'uploaderUrl=https://nexus/users/1', '',
    ].join('\r\n'));
  });

  it.each([
    ['the newest version the metadata records', '[General]\r\nnewestVersion=2.0\r\n', 'version=2.0.0.0'],
    ['zero when the metadata records none', '', 'version=0.0.0.0'],
  ])('writes %s for a file with no version of its own when the list stands for it', (_name, text, expected) => {
    expect(setNexusFileInfoInText(text, { game: 'fallout4', modID: '1', versionFromNewest: true, modVersion: '9.9' }, 'Fallout4')).toContain(expected);
  });
});
