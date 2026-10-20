import { describe, it, expect } from 'vitest';
import {
  parseDownloadMeta,
  setHiddenInText,
  setInstalledInText,
  setUninstalledInText,
} from '../../codecs/downloads';

describe('parseDownloadMeta', () => {
  it('uninstalled=true -> Uninstalled status', () => {
    expect(parseDownloadMeta('[General]\r\nuninstalled=true\r\n').status).toBe('Uninstalled');
  });

  it('reads the tooltip fields: modName, gameName, author', () => {
    const meta = parseDownloadMeta('[General]\r\nmodName=Sleep or Save\r\ngameName=Fallout4\r\nauthor=SomeAuthor\r\n');
    expect(meta.modName).toBe('Sleep or Save');
    expect(meta.gameName).toBe('Fallout4');
    expect(meta.author).toBe('SomeAuthor');
  });

  it('treats modID=0 as no id, same as an absent modID (Visit-on-Nexus gated off)', () => {
    expect(parseDownloadMeta('[General]\r\nmodID=0\r\n').modID).toBeUndefined();
  });

  it('treats fileID=0 as no id, same as an absent fileID', () => {
    expect(parseDownloadMeta('[General]\r\nfileID=0\r\n').fileID).toBeUndefined();
  });

  it('is not excluded when removed is explicitly false', () => {
    expect(parseDownloadMeta('[General]\r\nremoved=false\r\n').excluded).toBe(false);
  });

  it('never conflates the Uninstalled Status with excluded: both flags coexist, orthogonal axes derived from different keys (uninstalled=true, removed=true)', () => {
    const meta = parseDownloadMeta('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect(meta.status).toBe('Uninstalled');
    expect(meta.excluded).toBe(true);
  });

  it('parses a hand-edited .meta with padded key=value spacing, which a writer never would, the same as the tight form', () => {
    const tight = parseDownloadMeta('[General]\r\nmodID=12345\r\n');
    const padded = parseDownloadMeta('[General]\r\nmodID = 12345\r\n');
    expect(padded.modID).toBe('12345');
    expect(padded).toEqual(tight);
  });
});

describe('parseDownloadMeta values', () => {
  it('are decoded, as MO2 writes a name holding a comma quoted', () => {
    expect(parseDownloadMeta('[General]\r\nmodName="A, B"\r\n').modName).toBe('A, B');
  });
});

describe('setHiddenInText', () => {
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

describe('setInstalledInText', () => {
  it('creates a fresh [General] section with both keys when there is no .meta text', () => {
    expect(setInstalledInText('')).toBe('[General]\r\ninstalled=true\r\nuninstalled=false\r\n');
  });

  it('clears an earlier uninstall, so a reinstalled download reads Installed again, MO2\'s markInstalled writing uninstalled=false beside installed=true and a reader taking uninstalled first', () => {
    const uninstalled = setUninstalledInText('[General]\r\ninstalled=true\r\n');
    expect(parseDownloadMeta(uninstalled).status).toBe('Uninstalled');
    expect(parseDownloadMeta(setInstalledInText(uninstalled)).status).toBe('Installed');
  });

});

describe('setUninstalledInText', () => {
  it('leaves installed=true in place — it is a separate key, never cleared, as MO2 writes uninstalled=true on uninstall without clearing installed', () => {
    const text = '[General]\r\ninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });
});
