// A Windows program as its file holds it: a PE32+ image with one resource section, which holds a version resource
// when one is given.

const SECTION_RVA = 0x1000;
const SECTION_FILE_OFFSET = 0x200;
const PE_OFFSET = 0x40;
const OPTIONAL_HEADER_SIZE = 240;
const RT_VERSION = 16;
const SUBDIRECTORY = 0x80000000;

const utf16z = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

const padded = (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);

// A version resource block: its length, its value's length, its type, its key, its value and its children, each
// aligned to 32 bits.
function block(key: string, value: Buffer, valueLength: number, text: boolean, children: readonly Buffer[] = []): Buffer {
  const body = Buffer.concat([padded(Buffer.concat([Buffer.alloc(6), utf16z(key)])), padded(value), ...children.map(padded)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength, 2);
  body.writeUInt16LE(text ? 1 : 0, 4);
  return body;
}

function fixedFileInfo([major = 0, minor = 0, build = 0, revision = 0]: readonly number[]): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(((major << 16) | minor) >>> 0, 8);
  fixed.writeUInt32LE(((build << 16) | revision) >>> 0, 12);
  return fixed;
}

const LANGUAGE = 0x0409;
const CODE_PAGE = 0x04b0;

function versionInfo(fileVersion: readonly number[], productVersion: string | undefined): Buffer {
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(LANGUAGE, 0);
  translation.writeUInt16LE(CODE_PAGE, 2);
  const strings = productVersion === undefined ? [] : [
    block('StringFileInfo', Buffer.alloc(0), 0, true, [
      block('040904B0', Buffer.alloc(0), 0, true, [block('ProductVersion', utf16z(productVersion), productVersion.length + 1, true)]),
    ]),
    block('VarFileInfo', Buffer.alloc(0), 0, true, [block('Translation', translation, translation.length, false)]),
  ];
  return block('VS_VERSION_INFO', fixedFileInfo(fileVersion), 52, false, strings);
}

// The resource tree: type, then name, then language, each one entry, down to the version resource's data entry.
function resourceSection(version: Buffer): Buffer {
  const directory = (entryId: number, target: number): Buffer => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt16LE(1, 14);
    bytes.writeUInt32LE(entryId, 16);
    bytes.writeUInt32LE(target >>> 0, 20);
    return bytes;
  };
  const dataEntryAt = 72;
  const versionAt = 88;
  const dataEntry = Buffer.alloc(16);
  dataEntry.writeUInt32LE(SECTION_RVA + versionAt, 0);
  dataEntry.writeUInt32LE(version.length, 4);
  return Buffer.concat([
    directory(RT_VERSION, SUBDIRECTORY | 24), directory(1, SUBDIRECTORY | 48), directory(LANGUAGE, dataEntryAt), dataEntry, version,
  ]);
}

/** A Windows program whose version resource holds `fileVersion`, and `productVersion` when one is given; with no
 *  version resource when `fileVersion` is not given. */
export function windowsProgram({ fileVersion, productVersion }: { fileVersion?: readonly number[]; productVersion?: string } = {}): Buffer {
  const section = padded(fileVersion === undefined ? Buffer.alloc(16) : resourceSection(versionInfo(fileVersion, productVersion)));
  const headers = Buffer.alloc(SECTION_FILE_OFFSET);
  headers.write('MZ', 0, 'latin1');
  headers.writeUInt32LE(PE_OFFSET, 0x3c);
  headers.write('PE\0\0', PE_OFFSET, 'latin1');
  const coff = PE_OFFSET + 4;
  headers.writeUInt16LE(0x8664, coff);
  headers.writeUInt16LE(1, coff + 2);
  headers.writeUInt16LE(OPTIONAL_HEADER_SIZE, coff + 16);
  const optional = coff + 20;
  headers.writeUInt16LE(0x20b, optional);
  headers.writeUInt32LE(16, optional + 108);
  if (fileVersion !== undefined) {
    headers.writeUInt32LE(SECTION_RVA, optional + 112 + 2 * 8);
    headers.writeUInt32LE(section.length, optional + 112 + 2 * 8 + 4);
  }
  const sectionHeader = optional + OPTIONAL_HEADER_SIZE;
  headers.write('.rsrc', sectionHeader, 'latin1');
  headers.writeUInt32LE(section.length, sectionHeader + 8);
  headers.writeUInt32LE(SECTION_RVA, sectionHeader + 12);
  headers.writeUInt32LE(section.length, sectionHeader + 16);
  headers.writeUInt32LE(SECTION_FILE_OFFSET, sectionHeader + 20);
  return Buffer.concat([headers, section]);
}
