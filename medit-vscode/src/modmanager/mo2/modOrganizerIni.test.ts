import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGamePath, readSelectedProfile, setSelectedProfileInText } from './modOrganizerIni';

const iniPath = join(__dirname, '..', 'test', 'fixtures', 'mo2-instance', 'ModOrganizer.ini');
const ini = () => readFileSync(iniPath, 'utf8');

describe('readSelectedProfile', () => {
  it('unwraps an @ByteArray(...) value', () => {
    expect(readSelectedProfile(ini())).toBe('Default');
  });

  it('reads a plain (non-@ByteArray) value', () => {
    expect(readSelectedProfile('[General]\r\nselected_profile=My Profile\r\n')).toBe('My Profile');
  });

  it('throws when the key is absent', () => {
    expect(() => readSelectedProfile('[General]\r\ngameName=Fallout 4\r\n')).toThrow();
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

  it('throws when the key is absent', () => {
    expect(() => readGamePath('[General]\r\ngameName=Fallout 4\r\n')).toThrow();
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
});
