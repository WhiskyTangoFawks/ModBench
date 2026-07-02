// Tiny binary read of a plugin's TES4 header to extract its master list — no
// Mutagen, no backend. Reads only the header region (24-byte major-record
// header + its declared field-data length), never the whole plugin.

import { open } from 'node:fs/promises';

const HEADER_LENGTH = 24; // FO4 major-record header: sig(4) + size(4) + flags(4) + formID(4) + VC1(4) + formVersion(2) + VC2(2)
const SUBRECORD_HEADER_LENGTH = 6; // sig(4) + size(2, LE uint16)

export async function readMasters(pluginPath: string): Promise<string[]> {
  const handle = await open(pluginPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_LENGTH);
    await handle.read(header, 0, HEADER_LENGTH, 0);

    const signature = header.toString('ascii', 0, 4);
    if (signature !== 'TES4') {
      throw new Error(`${pluginPath}: expected a TES4 header, found "${signature}"`);
    }
    const contentLength = header.readUInt32LE(4);

    const fields = Buffer.alloc(contentLength);
    await handle.read(fields, 0, contentLength, HEADER_LENGTH);

    const masters: string[] = [];
    let offset = 0;
    while (offset + SUBRECORD_HEADER_LENGTH <= fields.length) {
      const subSignature = fields.toString('ascii', offset, offset + 4);
      const subSize = fields.readUInt16LE(offset + 4);
      const dataStart = offset + SUBRECORD_HEADER_LENGTH;
      if (subSignature === 'MAST') {
        const raw = fields.toString('utf8', dataStart, dataStart + subSize);
        masters.push(raw.replace(/\0+$/, ''));
      }
      offset = dataStart + subSize;
    }
    return masters;
  } finally {
    await handle.close();
  }
}
