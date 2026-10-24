// A Windows program's version resource, read from its file as Windows reads it, on Windows and Linux alike.

import { open } from 'node:fs/promises';

export type VersionResource =
  | { readonly kind: 'read'; readonly fileVersion: string; readonly productVersion: string }
  | { readonly kind: 'noVersionResource' }
  | { readonly kind: 'notAProgram' };

const MZ = 0x5a4d;
const PE = 0x00004550;
const OPTIONAL_HEADERS: Readonly<Record<number, number>> = { 0x10b: 96, 0x20b: 112 };
const MAX_OPTIONAL_HEADER = 240;
const MAX_SECTIONS = 96;
const MAX_DIRECTORY_ENTRIES = 1024;
// A version resource's length is a 16-bit count of its bytes.
const MAX_VERSION_INFO = 0xffff;
const RESOURCE_DIRECTORY = 2;
const RT_VERSION = 16;
const SUBDIRECTORY = 0x80000000;
const FIXED_FILE_INFO = 0xfeef04bd;

const NOT_A_PROGRAM = { kind: 'notAProgram' } as const;
const NO_VERSION_RESOURCE = { kind: 'noVersionResource' } as const;

type File = Awaited<ReturnType<typeof open>>;

async function bytesUpTo(file: File, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  return bytes.subarray(0, bytesRead);
}

async function bytesAt(file: File, position: number, length: number): Promise<Buffer | undefined> {
  const bytes = await bytesUpTo(file, position, length);
  return bytes.length === length ? bytes : undefined;
}

// Reads at an offset from the resource directory's start, within the resource section.
type ResourceRead = (offset: number, length: number, upTo?: boolean) => Promise<Buffer | undefined>;

async function resourcesIn(file: File): Promise<{ readonly kind: 'resources'; readonly read: ResourceRead; readonly rva: number } | Missing> {
  const dos = await bytesAt(file, 0, 64);
  if (dos?.readUInt16LE(0) !== MZ) return NOT_A_PROGRAM;
  const pe = dos.readUInt32LE(0x3c);
  const header = await bytesAt(file, pe, 24);
  if (header?.readUInt32LE(0) !== PE) return NOT_A_PROGRAM;
  const sectionCount = header.readUInt16LE(6);
  const optionalSize = header.readUInt16LE(20);
  const optional = await bytesUpTo(file, pe + 24, Math.min(optionalSize, MAX_OPTIONAL_HEADER));
  const directories = optional.length >= 2 ? OPTIONAL_HEADERS[optional.readUInt16LE(0)] : undefined;
  if (directories === undefined || optional.length < directories + 24 || sectionCount > MAX_SECTIONS) return NOT_A_PROGRAM;
  if (optional.readUInt32LE(directories - 4) <= RESOURCE_DIRECTORY) return NO_VERSION_RESOURCE;
  const rva = optional.readUInt32LE(directories + RESOURCE_DIRECTORY * 8);
  if (rva === 0) return NO_VERSION_RESOURCE;
  const table = await bytesAt(file, pe + 24 + optionalSize, sectionCount * 40);
  if (table === undefined) return NOT_A_PROGRAM;
  for (let i = 0; i < sectionCount; i++) {
    const virtualAddress = table.readUInt32LE(i * 40 + 12);
    const rawSize = table.readUInt32LE(i * 40 + 16);
    const rawStart = table.readUInt32LE(i * 40 + 20);
    const start = rva - virtualAddress;
    if (start < 0 || start >= rawSize) continue;
    const read: ResourceRead = (offset, length, upTo = false) => {
      const at = start + offset;
      if (at < 0 || at >= rawSize) return Promise.resolve(undefined);
      const bounded = Math.min(length, rawSize - at);
      if (upTo) return bytesUpTo(file, rawStart + at, bounded);
      return bounded < length ? Promise.resolve(undefined) : bytesAt(file, rawStart + at, length);
    };
    return { kind: 'resources', read, rva };
  }
  return NOT_A_PROGRAM;
}

type Missing = typeof NOT_A_PROGRAM | typeof NO_VERSION_RESOURCE;

// The target of a directory's entry: the one with `id`, or its first.
async function entryOf(read: ResourceRead, directory: number, id?: number): Promise<number | Missing> {
  const head = await read(directory, 16);
  if (head === undefined) return NOT_A_PROGRAM;
  const count = Math.min(head.readUInt16LE(12) + head.readUInt16LE(14), MAX_DIRECTORY_ENTRIES);
  const entries = await read(directory + 16, count * 8);
  if (entries === undefined) return NOT_A_PROGRAM;
  for (let i = 0; i < count; i++) {
    if (id === undefined || entries.readUInt32LE(i * 8) === id) return entries.readUInt32LE(i * 8 + 4);
  }
  return NO_VERSION_RESOURCE;
}

// The version resource of the program's first name and first language, read no further than its own length.
async function versionInfoIn(file: File): Promise<Buffer | Missing> {
  const resources = await resourcesIn(file);
  if (resources.kind !== 'resources') return resources;
  const { read, rva } = resources;
  let target = await entryOf(read, 0, RT_VERSION);
  for (let level = 0; level < 2; level++) {
    if (typeof target !== 'number') return target;
    if ((target & SUBDIRECTORY) === 0) return NO_VERSION_RESOURCE;
    target = await entryOf(read, target & ~SUBDIRECTORY);
  }
  if (typeof target !== 'number') return target;
  const dataEntry = await read(target, 16);
  if (dataEntry === undefined) return NOT_A_PROGRAM;
  const info = await read(dataEntry.readUInt32LE(0) - rva, Math.min(dataEntry.readUInt32LE(4), MAX_VERSION_INFO), true);
  return info === undefined || info.length < 6 ? NOT_A_PROGRAM : info.subarray(0, info.readUInt16LE(0));
}

interface Block {
  readonly key: string;
  readonly value: Buffer;
  readonly childrenStart: number;
  readonly end: number;
}

const aligned = (offset: number): number => (offset + 3) & ~3;

// A block of the version resource, ending at its own length or its parent's end, whichever comes first. A text value
// is counted in UTF-16 characters, any other in bytes.
function blockAt(info: Buffer, start: number, parentEnd: number): Block | undefined {
  if (start + 6 > parentEnd) return undefined;
  const length = info.readUInt16LE(start);
  if (length < 6) return undefined;
  const end = Math.min(start + length, parentEnd);
  const valueLength = info.readUInt16LE(start + 2);
  const text = info.readUInt16LE(start + 4) === 1;
  let keyEnd = start + 6;
  while (keyEnd + 2 <= end && info.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  const valueStart = Math.min(aligned(keyEnd + 2), end);
  const valueEnd = Math.min(end, valueStart + (text ? valueLength * 2 : valueLength));
  return { key: info.toString('utf16le', start + 6, keyEnd), value: info.subarray(valueStart, valueEnd), childrenStart: aligned(valueEnd), end };
}

function childOf(info: Buffer, parent: Block | undefined, key: string): Block | undefined {
  if (parent === undefined) return undefined;
  for (let child = blockAt(info, parent.childrenStart, parent.end); child !== undefined; child = blockAt(info, aligned(child.end), parent.end)) {
    if (child.key.toLowerCase() === key.toLowerCase()) return child;
  }
  return undefined;
}

const hex4 = (value: number): string => value.toString(16).padStart(4, '0');

function productVersionIn(info: Buffer, root: Block): string {
  const translation = childOf(info, childOf(info, root, 'VarFileInfo'), 'Translation')?.value;
  if (translation === undefined || translation.length < 4) return '';
  const table = childOf(info, childOf(info, root, 'StringFileInfo'), `${hex4(translation.readUInt16LE(0))}${hex4(translation.readUInt16LE(2))}`);
  return childOf(info, table, 'ProductVersion')?.value.toString('utf16le').split('\0')[0] ?? '';
}

/** The program's fixed file version, as its four numbers, and the product version its first translation names, empty
 *  when it names none. Rejects only as the file system does. */
export async function versionResourceOf(path: string): Promise<VersionResource> {
  const file = await open(path, 'r');
  try {
    const info = await versionInfoIn(file);
    if (!Buffer.isBuffer(info)) return info;
    const root = blockAt(info, 0, info.length);
    if (root === undefined || root.value.length < 52 || root.value.readUInt32LE(0) !== FIXED_FILE_INFO) return NO_VERSION_RESOURCE;
    const high = root.value.readUInt32LE(8);
    const low = root.value.readUInt32LE(12);
    const fileVersion = [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join('.');
    return { kind: 'read', fileVersion, productVersion: productVersionIn(info, root) };
  } finally {
    await file.close();
  }
}
