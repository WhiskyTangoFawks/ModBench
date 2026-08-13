import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGameName, readGamePath, readSelectedProfile, setSelectedProfileInText } from './modOrganizerIni';

const iniPath = join(__dirname, '..', 'test', 'fixtures', 'mo2-instance', 'ModOrganizer.ini');
const ini = () => readFileSync(iniPath, 'utf8');

describe('readSelectedProfile', () => {
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

  it('does not spuriously match a key-like line lacking "=" (#317)', () => {
    // Under a mutated eq!==-1 guard, "selected_profileX" (no "=") would slice(0,-1)
    // to exactly "selected_profile" and wrongly win — the real, later "=" line
    // must be what's actually returned. Real files' own headers/blanks (eq===-1)
    // already exercise this guard; this fixture is what actually discriminates it.
    const text = '[General]\r\nselected_profileX\r\nselected_profile=Real Value\r\n';
    expect(readSelectedProfile(text)).toBe('Real Value');
  });
});

describe('readGameName', () => {
  it('throws a message naming the missing key when gameName is absent (#317)', () => {
    expect(() => readGameName('[General]\r\nselected_profile=Default\r\n')).toThrow(/missing gameName/);
  });
});

describe('readGamePath', () => {
  it('unwraps an @ByteArray(...) value from the fixture', () => {
    expect(readGamePath(ini())).toBe(String.raw`Z:\\\\path\\to\\Stock Game Folder`);
  });

  it('reads a plain (non-@ByteArray) value', () => {
    const text = '[General]\r\ngamePath=' + String.raw`C:\Games\Fallout4` + '\r\n';
    expect(readGamePath(text)).toBe(String.raw`C:\Games\Fallout4`);
  });

  it('throws a message naming the missing key when the key is absent', () => {
    expect(() => readGamePath('[General]\r\ngameName=Fallout 4\r\n')).toThrow(/missing gamePath/);
  });
});

describe('setSelectedProfileInText — surgical, byte-faithful', () => {
  it('rewrites only the selected_profile value, preserving every other byte', () => {
    const input = ini();
    const out = setSelectedProfileInText(input, 'Secondary');
    expect(out).toBe(input.replace('@ByteArray(Default)', '@ByteArray(Secondary)'));
    expect(readSelectedProfile(out)).toBe('Secondary');
    expect(out).toContain('[Settings]\r\nlanguage=en\r\n'); // other section untouched
    expect(out).toContain('gamePath=@ByteArray('); // gamePath untouched
  });

  it('is a no-op (identical bytes) when setting the current profile', () => {
    expect(setSelectedProfileInText(ini(), 'Default')).toBe(ini());
  });

  it('throws a message naming the missing key when selected_profile is absent (#317)', () => {
    expect(() => setSelectedProfileInText('[General]\r\ngameName=Fallout 4\r\n', 'X')).toThrow(
      /missing selected_profile/,
    );
  });
});
