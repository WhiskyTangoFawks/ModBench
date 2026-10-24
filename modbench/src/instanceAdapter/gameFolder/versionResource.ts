// A Windows program's version resource, read from its file as Windows reads it, on Windows and Linux alike.

import { open } from 'node:fs/promises';

const MZ = 0x5a4d;
const PE = 0x00004550;
const PE32_PLUS = 0x20b;
const RESOURCE_DIRECTORY = 2;
const RT_VERSION = 16;
const SUBDIRECTORY = 0x80000000;
const FIXED_FILE_INFO = 0xfeef04bd;

class NotAProgram extends Error {}

type File = Awaited<ReturnType<typeof open>>;

async function bytesAt(file: File, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  if (bytesRead < length) throw new NotAProgram();
  return bytes;
}

// The resource directory and the rest of its section, and where an address falls in them; none when the program has no
// resources.
async function resources(file: File): Promise<{ readonly section: Buffer; readonly at: (rva: number) => number } | undefined> {
  const dos = await bytesAt(file, 0, 64);
  if (dos.readUInt16LE(0) !== MZ) throw new NotAProgram();
  const pe = dos.readUInt32LE(0x3c);
  const header = await bytesAt(file, pe, 24);
  if (header.readUInt32LE(0) !== PE) throw new NotAProgram();
  const sectionCount = header.readUInt16LE(6);
  const optionalSize = header.readUInt16LE(20);
  const optional = await bytesAt(file, pe + 24, optionalSize);
  const directories = optional.readUInt16LE(0) === PE32_PLUS ? 112 : 96;
  if (optional.readUInt32LE(directories - 4) <= RESOURCE_DIRECTORY) return undefined;
  const rva = optional.readUInt32LE(directories + RESOURCE_DIRECTORY * 8);
  if (rva === 0) return undefined;
  const table = await bytesAt(file, pe + 24 + optionalSize, sectionCount * 40);
  for (let i = 0; i < sectionCount; i++) {
    const virtualSize = table.readUInt32LE(i * 40 + 8);
    const virtualAddress = table.readUInt32LE(i * 40 + 12);
    const rawSize = table.readUInt32LE(i * 40 + 16);
    if (rva < virtualAddress || rva >= virtualAddress + Math.max(virtualSize, rawSize)) continue;
    const section = await bytesAt(file, table.readUInt32LE(i * 40 + 20), rawSize);
    return { section: section.subarray(rva - virtualAddress), at: (each) => each - rva };
  }
  throw new NotAProgram();
}

// The target of a directory's entry: the one with `id`, or its first.
function entryOf(section: Buffer, directory: number, id?: number): number | undefined {
  const count = section.readUInt16LE(directory + 12) + section.readUInt16LE(directory + 14);
  for (let i = 0; i < count; i++) {
    const entry = directory + 16 + i * 8;
    if (id === undefined || section.readUInt32LE(entry) === id) return section.readUInt32LE(entry + 4);
  }
  return undefined;
}

class NoVersionResource extends Error {}

// The version resource of the program's first name and first language.
async function versionInfoIn(file: File): Promise<Buffer> {
  const found = await resources(file);
  if (found === undefined) throw new NoVersionResource();
  const { section, at } = found;
  let target = entryOf(section, 0, RT_VERSION);
  for (let level = 0; level < 2; level++) {
    if (target === undefined || (target & SUBDIRECTORY) === 0) throw new NoVersionResource();
    target = entryOf(section, target & ~SUBDIRECTORY);
  }
  if (target === undefined) throw new NoVersionResource();
  const start = at(section.readUInt32LE(target));
  const end = start + section.readUInt32LE(target + 4);
  if (start < 0 || end > section.length) throw new NotAProgram();
  return section.subarray(start, end);
}

interface Block {
  readonly key: string;
  readonly value: Buffer;
  readonly children: readonly Block[];
}

const aligned = (offset: number): number => (offset + 3) & ~3;

// A block of the version resource and the blocks under it; a text value is in UTF-16 characters, any other in bytes.
function blockAt(info: Buffer, start: number): Block & { readonly end: number } {
  const end = start + info.readUInt16LE(start);
  const valueLength = info.readUInt16LE(start + 2);
  const text = info.readUInt16LE(start + 4) === 1;
  let keyEnd = start + 6;
  while (keyEnd + 1 < end && info.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  const valueStart = aligned(keyEnd + 2);
  const valueEnd = Math.min(end, valueStart + (text ? valueLength * 2 : valueLength));
  const children: Block[] = [];
  let child = aligned(valueEnd);
  while (child + 6 <= end && info.readUInt16LE(child) > 0) {
    const read = blockAt(info, child);
    children.push(read);
    child = aligned(read.end);
  }
  return { key: info.toString('utf16le', start + 6, keyEnd), value: info.subarray(valueStart, valueEnd), children, end };
}

const childOf = (block: Block | undefined, key: string): Block | undefined =>
  block?.children.find((child) => child.key.toLowerCase() === key.toLowerCase());

const hex4 = (value: number): string => value.toString(16).padStart(4, '0');

async function readVersion(path: string, read: (root: Block) => string): Promise<string> {
  const file = await open(path, 'r');
  try {
    return read(blockAt(await versionInfoIn(file), 0));
  } catch (err) {
    if (err instanceof NoVersionResource) throw new Error(`${path} has no version resource`);
    if (err instanceof NotAProgram || err instanceof RangeError) throw new Error(`${path} is not a Windows program`);
    throw err;
  } finally {
    await file.close();
  }
}

function fileVersion({ value }: Block): string {
  if (value.length < 52 || value.readUInt32LE(0) !== FIXED_FILE_INFO) throw new NoVersionResource();
  const high = value.readUInt32LE(8);
  const low = value.readUInt32LE(12);
  return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join('.');
}

function productVersion(root: Block): string {
  const translation = childOf(childOf(root, 'VarFileInfo'), 'Translation')?.value;
  if (translation === undefined || translation.length < 4) return '';
  const table = childOf(childOf(root, 'StringFileInfo'), `${hex4(translation.readUInt16LE(0))}${hex4(translation.readUInt16LE(2))}`);
  return childOf(table, 'ProductVersion')?.value.toString('utf16le').split('\0')[0] ?? '';
}

/** The program's fixed file version, as its four numbers. Rejects a program with no version resource. */
export async function fileVersionOf(path: string): Promise<string> {
  return readVersion(path, fileVersion);
}

/** The product version the program's first translation names; empty when it names none. */
export async function productVersionOf(path: string): Promise<string> {
  return readVersion(path, productVersion);
}
