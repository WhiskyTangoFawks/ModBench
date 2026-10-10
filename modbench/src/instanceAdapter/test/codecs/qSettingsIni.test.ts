import { describe, it, expect } from 'vitest';
import { decodeIniValue, readIniSection, readIniValue, replaceIniSection, setIniValue } from '../../codecs/qSettingsIni';

describe('readIniValue', () => {
  it('reads the key in the named section, not the same key in another', () => {
    const text = '[A]\r\nk=wrong\r\n[B]\r\nk=right\r\n';
    expect(readIniValue(text, 'B', 'k')).toBe('right');
  });

  it('is undefined when the section lacks the key', () => {
    expect(readIniValue('[A]\r\nk=1\r\n[B]\r\n', 'B', 'k')).toBeUndefined();
  });

  it('trims padding around the key and the value', () => {
    expect(readIniValue('[A]\r\n k = v \r\n', 'A', 'k')).toBe('v');
  });

  it('ignores a line with no "=", whose whole text would otherwise pass for a key', () => {
    expect(readIniValue('[A]\r\nkx\r\nk=1\r\n', 'A', 'k')).toBe('1');
  });
});

describe('keys above the first header', () => {
  it('read as [General], as QSettings does', () => {
    expect(readIniValue('k=1\r\n[A]\r\nk=2\r\n', 'General', 'k')).toBe('1');
  });

  it('are set in place as [General]', () => {
    expect(setIniValue('k=1\r\n[A]\r\nk=2\r\n', 'General', 'k', '9')).toBe('k=9\r\n[A]\r\nk=2\r\n');
  });
});

describe('a repeated key', () => {
  it('reads and sets its first line', () => {
    const text = '[A]\nk=1\nk=2\n';
    expect(readIniValue(text, 'A', 'k')).toBe('1');
    expect(setIniValue(text, 'A', 'k', '9')).toBe('[A]\nk=9\nk=2\n');
  });
});

describe('readIniSection', () => {
  it('maps every key of the section and none of another', () => {
    expect([...readIniSection('[A]\na=1\n[B]\nb=2\nc=3\n', 'B')]).toEqual([['b', '2'], ['c', '3']]);
  });

  it('is empty for a missing section', () => {
    expect(readIniSection('[A]\na=1\n', 'B').size).toBe(0);
  });
});

describe('decodeIniValue', () => {
  it.each([
    ['unwraps @ByteArray and un-escapes inside it, as Qt writes a path there', '@ByteArray(C:\\\\Mod\\\\x)', 'C:\\Mod\\x'],
    ['un-escapes doubled backslashes', 'C:\\\\Games', 'C:\\Games'],
    ['strips the quote wrapper and un-escapes', '"C:\\\\Games;New"', 'C:\\Games;New'],
    ['leaves an unknown escape as written', 'C:\\Games', 'C:\\Games'],
    ['reads an empty value as empty', '', ''],
  ])('%s', (_name, raw, expected) => {
    expect(decodeIniValue(raw)).toBe(expected);
  });
});

describe('values written by setIniValue', () => {
  it.each([
    ['a comma', 'a,b'],
    ['a backslash', 'C:\\Mod\\x'],
    ['a quote', 'say "hi"'],
    ['a semicolon and an equals sign', 'a;b=c'],
    ['leading and trailing spaces', ' padded '],
    ['a newline', 'a\nb'],
    ['plain text', 'My Profile'],
  ])('read back as written: %s', (_name, value) => {
    const text = setIniValue('[A]\n', 'A', 'k', value);
    expect(decodeIniValue(readIniValue(text, 'A', 'k') ?? '')).toBe(value);
  });

  it('quote a comma, as Qt writes category="-1,"', () => {
    expect(setIniValue('[A]\n', 'A', 'k', '-1,')).toBe('[A]\nk="-1,"\n');
  });

  it('leave plain text bare', () => {
    expect(setIniValue('[A]\n', 'A', 'k', 'My Profile')).toBe('[A]\nk=My Profile\n');
  });
});

describe('setIniValue', () => {
  it('replaces the key in its section only', () => {
    const text = '[A]\r\nk=1\r\n[B]\r\nk=2\r\n';
    expect(setIniValue(text, 'B', 'k', '9')).toBe('[A]\r\nk=1\r\n[B]\r\nk=9\r\n');
  });

  it('adds an absent key right after its section header', () => {
    expect(setIniValue('[A]\r\nx=1\r\n[B]\r\n', 'A', 'k', '9')).toBe('[A]\r\nk=9\r\nx=1\r\n[B]\r\n');
  });

  it('adds an absent section ahead of everything', () => {
    expect(setIniValue('[B]\r\nx=1\r\n', 'A', 'k', '9')).toBe('[A]\r\nk=9\r\n[B]\r\nx=1\r\n');
  });

  it('writes an empty value as an empty key rather than deleting it', () => {
    expect(setIniValue('[A]\nk=1\n', 'A', 'k', '')).toBe('[A]\nk=\n');
  });

  it('deletes the key when the value is undefined', () => {
    expect(setIniValue('[A]\nk=1\nx=2\n', 'A', 'k', undefined)).toBe('[A]\nx=2\n');
  });

  it('adds nothing, not even a section, to delete an absent key', () => {
    expect(setIniValue('[B]\nx=2\n', 'A', 'k', undefined)).toBe('[B]\nx=2\n');
  });

  it('keeps every other byte of an unchanged file, BOM included', () => {
    const text = '\uFEFF[A]\r\n; note\r\nk=1\r\n\r\n[B]\r\nx=@ByteArray(a\\\\b)\r\n';
    expect(setIniValue(text, 'A', 'k', '1')).toBe(text);
  });
});

describe('replaceIniSection', () => {
  it('replaces a section whole, leaving its neighbours', () => {
    expect(replaceIniSection('[A]\nx=1\ny=2\n[B]\nz=3\n', 'A', ['q=0'])).toBe('[A]\nq=0\n[B]\nz=3\n');
  });

  it('appends an absent section at the end', () => {
    expect(replaceIniSection('[A]\nx=1\n', 'B', ['q=0'])).toBe('[A]\nx=1\n[B]\nq=0\n');
  });

  it('removes the section when no lines remain', () => {
    expect(replaceIniSection('[A]\nx=1\n[B]\nz=3\n', 'A', [])).toBe('[B]\nz=3\n');
  });

  it('leaves text without the section alone when no lines remain', () => {
    expect(replaceIniSection('[A]\nx=1\n', 'B', [])).toBe('[A]\nx=1\n');
  });
});
