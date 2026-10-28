// Binary VDF, read as latin1 so each byte is one character: a tag byte, a NUL-ended key, then the value.
// 0x00 opens a map that 0x08 closes, 0x01 is a NUL-ended string, 0x02 a little-endian uint32.

export interface Shortcut {
  /** The ID Steam names the shortcut's folder under steamapps/compatdata by. */
  readonly appId: number;
  readonly exe: string;
}

type Value = string | number | VdfMap;
interface VdfMap {
  readonly [key: string]: Value;
}

const MAP = 0x00;
const STRING = 0x01;
const UINT32 = 0x02;
const END = 0x08;

function readMap(bytes: string, start: number): { map: VdfMap; next: number } {
  const map: Record<string, Value> = {};
  let at = start;
  const text = (): string => {
    const end = bytes.indexOf('\0', at);
    if (end < 0) throw new Error('shortcuts.vdf ends inside a string');
    const value = Buffer.from(bytes.slice(at, end), 'latin1').toString('utf8');
    at = end + 1;
    return value;
  };
  while (at < bytes.length) {
    const tag = bytes.charCodeAt(at++);
    if (tag === END) return { map, next: at };
    const key = text().toLowerCase();
    if (tag === STRING) map[key] = text();
    else if (tag === UINT32) {
      map[key] = Buffer.from(bytes.slice(at, at + 4), 'latin1').readUInt32LE();
      at += 4;
    } else if (tag === MAP) {
      const nested = readMap(bytes, at);
      map[key] = nested.map;
      at = nested.next;
    } else throw new Error(`shortcuts.vdf holds the unknown tag ${tag}`);
  }
  throw new Error('shortcuts.vdf ends inside a map');
}

/** The shortcuts the file holds, each with its ID and program; one with neither is left out. */
export function shortcutsIn(file: string): Shortcut[] {
  const shortcuts = readMap(file, 0).map.shortcuts;
  if (typeof shortcuts !== 'object') return [];
  const found: Shortcut[] = [];
  for (const entry of Object.values(shortcuts)) {
    if (typeof entry !== 'object') continue;
    const { appid, exe } = entry;
    if (typeof appid === 'number' && typeof exe === 'string') found.push({ appId: appid, exe: exe.replace(/^"(.*)"$/, '$1') });
  }
  return found;
}
