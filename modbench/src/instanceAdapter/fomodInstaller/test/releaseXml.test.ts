import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseXmlText } from '../releaseXml';

const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
const cyrillicInWindows1251 = (text: string): Buffer =>
  Buffer.from(Array.from({ length: text.length }, (_, i) => {
    const code = text.charCodeAt(i);
    return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
  }));
const EVEN_UTF8 = '<?xml version="1.0" encoding="UTF-16"?><a>Adé</a>';

describe('a FOMOD\'s XML file, read as MO2 reads it', () => {
  let folder: string;
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it.each([
    ['UTF-8 with a byte order mark', Buffer.from('﻿<a>Adé</a>'), '﻿<a>Adé</a>'],
    ['UTF-8, of an even length that UTF-16 would decode, whose declaration names UTF-16',
      Buffer.from(Buffer.byteLength(EVEN_UTF8) % 2 === 0 ? EVEN_UTF8 : `${EVEN_UTF8}\n`), EVEN_UTF8],
    ['UTF-16 little-endian, by its byte order mark', utf16le('<a>Adé</a>'), '﻿<a>Adé</a>'],
    ['UTF-16 big-endian, by its byte order mark', utf16be('<a>Adé</a>'), '﻿<a>Adé</a>'],
    ['UTF-16 little-endian with no byte order mark, by its first characters', Buffer.from('<?xml version="1.0"?><a>Adé</a>', 'utf16le'), '<?xml version="1.0"?><a>Adé</a>'],
    ['the encoding its declaration names', cyrillicInWindows1251('<?xml version="1.0" encoding="windows-1251"?><a>Иван</a>'), '<?xml version="1.0" encoding="windows-1251"?><a>Иван</a>'],
    ['neither UTF-8 nor UTF-16 and naming none, as Windows-1252, where MO2 falls back to Latin-1', Buffer.from('<a>Adé</a>', 'latin1'), '<a>Adé</a>'],
  ])('reads a file in %s', async (_, bytes, text) => {
    folder = await mkdtemp(join(tmpdir(), 'fomod-xml-'));
    await writeFile(join(folder, 'info.xml'), bytes);

    expect((await releaseXmlText(join(folder, 'info.xml'))).trimEnd()).toBe(text);
  });
});
