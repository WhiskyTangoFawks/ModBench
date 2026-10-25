import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readDownloadDirectory, readGameName, readGamePath, readSelectedProfile, setSelectedProfileInText,
} from '../../codecs/modOrganizerIni';

const iniPath = join(__dirname, '..', '..', '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance', 'ModOrganizer.ini');
const ini = () => readFileSync(iniPath, 'utf8');

describe('the selected profile ModOrganizer.ini names', () => {
  it('unwraps an @ByteArray(...) value', () => {
    expect(readSelectedProfile(ini())).toBe('Default');
  });

  it('reads a plain (non-@ByteArray) value', () => {
    expect(readSelectedProfile('[General]\r\nselected_profile=My Profile\r\n')).toBe('My Profile');
  });

  it('throws a message naming the missing key when the key is absent', () => {
    expect(() => readSelectedProfile('[General]\r\ngameName=Fallout 4\r\n')).toThrow(
      /missing selected_profile/,
    );
  });

});

describe('section-aware lookup', () => {
  it('does not find a key that exists only in another section', () => {
    expect(() => readSelectedProfile('[Settings]\r\nselected_profile=Wrong\r\n')).toThrow(/missing selected_profile/);
  });

});

describe('the game name ModOrganizer.ini names', () => {
  it('throws a message naming the missing key when gameName is absent', () => {
    expect(() => readGameName('[General]\r\nselected_profile=Default\r\n')).toThrow(/missing gameName/);
  });
});

describe('the game path ModOrganizer.ini names', () => {
  it('unwraps an @ByteArray(...) value from the fixture', () => {
    expect(readGamePath(ini())).toBe(String.raw`Z:\\path\to\Stock Game Folder`);
  });

  it('reads a plain (non-@ByteArray) value', () => {
    const text = '[General]\r\ngamePath=' + String.raw`C:\\Games\\Fallout4` + '\r\n';
    expect(readGamePath(text)).toBe(String.raw`C:\Games\Fallout4`);
  });

  it('throws a message naming the missing key when the key is absent', () => {
    expect(() => readGamePath('[General]\r\ngameName=Fallout 4\r\n')).toThrow(/missing gamePath/);
  });
});

describe('the download directory ModOrganizer.ini names', () => {
  it('answers undefined when the key is absent, so MO2\'s own default applies', () => {
    expect(readDownloadDirectory(ini())).toBeUndefined();
  });

  it('un-escapes the doubled backslashes MO2/Qt actually writes for a plain Windows path, download_directory being a plain QString (settings.cpp:1683), never @ByteArray unlike gamePath', () => {
    const onDisk = String.raw`download_directory=C:\\Games\\MO2\\downloads`;
    expect(readDownloadDirectory(`[Settings]\r\n${onDisk}\r\n`)).toBe(String.raw`C:\Games\MO2\downloads`);
  });

  it('unwraps an @ByteArray(...) value holding no escapes', () => {
    expect(readDownloadDirectory('[Settings]\r\ndownload_directory=@ByteArray(%BASE_DIR%/downloads)\r\n'))
      .toBe('%BASE_DIR%/downloads');
  });

  it('reads an empty value as unset, as MO2\'s own default-path behaviour does, its settings dialog removing the key rather than writing it empty (setConfigurablePath)', () => {
    expect(readDownloadDirectory('[Settings]\r\ndownload_directory=\r\n')).toBeUndefined();
  });
});

describe('the selected profile written to ModOrganizer.ini, every other byte kept', () => {
  it.each(['a,b', 'back\\slash', 'say "hi"', ' padded '])('writes %j so that readSelectedProfile reads it back', (name) => {
    expect(readSelectedProfile(setSelectedProfileInText(ini(), name))).toBe(name);
  });

  it('rewrites only the selected_profile value, preserving every other byte', () => {
    const input = ini();
    const out = setSelectedProfileInText(input, 'Secondary');
    expect(out).toBe(input.replace('@ByteArray(Default)', '@ByteArray(Secondary)'));
    expect(readSelectedProfile(out)).toBe('Secondary');
    expect(out).toContain('[Settings]\r\nlanguage=en\r\n');
    expect(out).toContain('gamePath=@ByteArray(');
  });

  it('is a no-op (identical bytes) when setting the current profile', () => {
    expect(setSelectedProfileInText(ini(), 'Default')).toBe(ini());
  });

  it('throws a message naming the missing key when selected_profile is absent', () => {
    expect(() => setSelectedProfileInText('[General]\r\ngameName=Fallout 4\r\n', 'X')).toThrow(
      /missing selected_profile/,
    );
  });
});
