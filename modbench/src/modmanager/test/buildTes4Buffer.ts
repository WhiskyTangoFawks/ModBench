// A minimal TES4 plugin header: 24-byte TES4 header, HEDR, then the
// MAST/DATA subrecords, laid out as masterReader.ts reads them.

export function buildTes4Buffer(masters: string[], opts: { dataAfterFirstMaster?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];

  const hedr = Buffer.alloc(6 + 12); // sig+size header + 12-byte HEDR payload (float, u32, u32)
  hedr.write('HEDR', 0, 'ascii');
  hedr.writeUInt16LE(12, 4);
  parts.push(hedr);

  masters.forEach((name, i) => {
    const nameBytes = Buffer.from(name + '\0', 'ascii');
    const mast = Buffer.alloc(6 + nameBytes.length);
    mast.write('MAST', 0, 'ascii');
    mast.writeUInt16LE(nameBytes.length, 4);
    nameBytes.copy(mast, 6);
    parts.push(mast);

    if (opts.dataAfterFirstMaster && i === 0) {
      const data = Buffer.alloc(6 + 8);
      data.write('DATA', 0, 'ascii');
      data.writeUInt16LE(8, 4);
      parts.push(data);
    }
  });

  const fields = Buffer.concat(parts);
  const header = Buffer.alloc(24);
  header.write('TES4', 0, 'ascii');
  header.writeUInt32LE(fields.length, 4); // content length
  header.writeUInt32LE(0, 8); // flags
  header.writeUInt32LE(0, 12); // formID
  header.writeUInt32LE(0, 16); // VC1
  header.writeUInt16LE(0, 20); // form version
  header.writeUInt16LE(0, 22); // VC2

  return Buffer.concat([header, fields]);
}
