import { describe, it, expect } from 'vitest';
import { readIniSection, readIniValue, replaceIniSection, setIniByteArray, setIniValue } from '../../codecs/qSettingsIni';

describe('a value read from a QSettings INI', () => {
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

describe('a section read from a QSettings INI', () => {
  it('maps every key of the section and none of another', () => {
    expect([...readIniSection('[A]\na=1\n[B]\nb=2\nc=3\n', 'B')]).toEqual([['b', '2'], ['c', '3']]);
  });

  it('is empty for a missing section', () => {
    expect(readIniSection('[A]\na=1\n', 'B').size).toBe(0);
  });
});

describe('decoded values', () => {
  it.each([
    ['unwraps @ByteArray and un-escapes inside it, as Qt writes a path there', '@ByteArray(C:\\\\Mod\\\\x)', 'C:\\Mod\\x'],
    ['un-escapes doubled backslashes', 'C:\\\\Games', 'C:\\Games'],
    ['strips the quote wrapper and un-escapes', '"C:\\\\Games;New"', 'C:\\Games;New'],
    ['drops an unknown escape with its character, as Qt does', 'C:\\Games', 'C:ames'],
    ['reads the named control escapes', 'a\\ab\\bc\\fd\\ve', 'a\x07b\x08c\x0cd\x0be'],
    ['reads a hex escape of any length as one UTF-16 unit, as Qt5 wrote', 'caf\\xe9 \\x20ac', 'caf\u00e9 \u20ac'],
    ['reads an octal escape', 'a\\0b\\101', 'a\0bA'],
    ['reads a leading @@ as one @', '@@Variant(x)', '@Variant(x)'],
    ['reads a unit above 0xFF in a @ByteArray as ?, as toLatin1 does', '@ByteArray(a\\x20acz)', 'a?z'],
    ['reads the UTF-8 bytes of a @ByteArray as text', '@ByteArray(caf\\xc3\\xa9)', 'caf\u00e9'],
    ['reads an empty value as empty', '', ''],
  ])('%s', (_name, raw, expected) => {
    expect(readIniValue(`[A]\nk=${raw}\n`, 'A', 'k')).toBe(expected);
  });

  it('reach readIniSection decoded too', () => {
    expect(readIniSection('[A]\nk="a,b"\n', 'A').get('k')).toBe('a,b');
  });
});

describe('values written to a QSettings INI, read back as written', () => {
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
    expect(readIniValue(text, 'A', 'k')).toBe(value);
  });

  it('quote a comma, as Qt writes category="-1,"', () => {
    expect(setIniValue('[A]\n', 'A', 'k', '-1,')).toBe('[A]\nk="-1,"\n');
  });

  it('leave plain text bare', () => {
    expect(setIniValue('[A]\n', 'A', 'k', 'My Profile')).toBe('[A]\nk=My Profile\n');
  });
});

describe('a value set in a QSettings INI', () => {
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

describe('a section replaced whole in a QSettings INI', () => {
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

describe('Qt escapes written', () => {
  it.each([
    ['a control character as \\x with the next hex digit escaped too', 'a\x015', 'a\\x1\\x35'],
    ['a NUL as \\0', '\0', '\\0'],
    ['a named control', 'a\nb\tc', 'a\\nb\\tc'],
    ['a leading @ doubled', '@x', '@@x'],
    ['non-ASCII as UTF-8', 'caf\u00e9', 'caf\u00e9'],
  ])('%s', (_name, value, raw) => {
    expect(setIniValue('[A]\n', 'A', 'k', value)).toBe(`[A]\nk=${raw}\n`);
    expect(readIniValue(`[A]\nk=${raw}\n`, 'A', 'k')).toBe(value);
  });
});

describe('a value set as a byte array in a QSettings INI', () => {
  it('escapes a hex digit after an escaped byte, as Qt does', () => {
    expect(setIniByteArray('[A]\n', 'A', 'k', 'Pröfil')).toBe('[A]\nk=@ByteArray(Pr\\xc3\\xb6\\x66il)\n');
  });

  it('writes the UTF-8 bytes at or above 0x7F as \\xNN, as Qt does for a QByteArray', () => {
    expect(setIniByteArray('[A]\n', 'A', 'k', 'caf\u00e9')).toBe('[A]\nk=@ByteArray(caf\\xc3\\xa9)\n');
  });

  it('reads back as written', () => {
    const text = setIniByteArray('[A]\n', 'A', 'k', 'Pr\u00f6fil, \\x "q"');
    expect(readIniValue(text, 'A', 'k')).toBe('Pr\u00f6fil, \\x "q"');
  });
});
