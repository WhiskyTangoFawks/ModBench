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

describe('setHiddenInText', () => {
  it('creates a fresh [General] section with removed=true when there is no .meta text', () => {
    expect(setHiddenInText('', true)).toBe('[General]\r\nremoved=true\r\n');
  });

  it('inserts removed=true after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(
      '[General]\r\nremoved=true\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing removed=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nremoved=false\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(
      '[General]\r\ngameName=Fallout4\r\nremoved=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when removed=true is already present', () => {
    const text = '[General]\r\nremoved=true\r\nmodid=12345\r\n';
    expect(setHiddenInText(text, true)).toBe(text);
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

  it('inserts both keys after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\ninstalled=true\r\nuninstalled=false\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing installed=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\ninstalled=false\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(
      '[General]\r\nuninstalled=false\r\ngameName=Fallout4\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when both keys already read installed', () => {
    const text = '[General]\r\ninstalled=true\r\nuninstalled=false\r\nmodid=12345\r\n';
    expect(setInstalledInText(text)).toBe(text);
  });

  it('clears an earlier uninstall, so a reinstalled download reads Installed again, MO2\'s markInstalled writing uninstalled=false beside installed=true and a reader taking uninstalled first', () => {
    const uninstalled = setUninstalledInText('[General]\r\ninstalled=true\r\n');
    expect(parseDownloadMeta(uninstalled).status).toBe('Uninstalled');
    expect(parseDownloadMeta(setInstalledInText(uninstalled)).status).toBe('Installed');
  });

  it('preserves LF-only line endings when inserting after an existing [General] header, a .meta from a platform that writes bare LF keeping its own convention though MO2 writes CRLF on Windows', () => {
    const text = '[General]\ngameName=Fallout4\n';
    expect(setInstalledInText(text)).toBe('[General]\ninstalled=true\nuninstalled=false\ngameName=Fallout4\n');
  });
});

describe('setUninstalledInText', () => {
  it('creates a fresh [General] section with uninstalled=true when there is no .meta text', () => {
    expect(setUninstalledInText('')).toBe('[General]\r\nuninstalled=true\r\n');
  });

  it('inserts uninstalled=true after an existing [General] header, preserving other lines', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ngameName=Fallout4\r\nmodid=12345\r\n',
    );
  });

  it('flips an existing uninstalled=false to true in place, byte-faithful', () => {
    const text = '[General]\r\ngameName=Fallout4\r\nuninstalled=false\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\ngameName=Fallout4\r\nuninstalled=true\r\nmodid=12345\r\n',
    );
  });

  it('is a no-op when uninstalled=true is already present', () => {
    const text = '[General]\r\nuninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(text);
  });

  it('leaves installed=true in place — it is a separate key, never cleared, as MO2 writes uninstalled=true on uninstall without clearing installed', () => {
    const text = '[General]\r\ninstalled=true\r\nmodid=12345\r\n';
    expect(setUninstalledInText(text)).toBe(
      '[General]\r\nuninstalled=true\r\ninstalled=true\r\nmodid=12345\r\n',
    );
  });
});
