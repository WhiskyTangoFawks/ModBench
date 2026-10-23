// Wabbajack's implementation of the Instance adapter as a publisher (ADR-0024): the publisher tags its
// compiler settings hold, as its compiler applies them, and never a mod's metadata (publishing.md,
// Publisher tags, story 5).

import { join, relative, sep } from 'node:path';
import { errorMessage } from '../../ports/errorMessage';
import { get, readOrAbsent } from '../files';
import type { Covering, PublisherConfiguration, PublisherTag } from '../instanceAdapter';
import type { ConfigurationFile, Publisher } from '../publisher';
import { watchFiles } from '../watchFiles';

// Wabbajack's configuration, at the instance root. Wabbajack writes this machine's own paths, or on Wine a Windows
// program's, a Windows one in JSON's escaped backslashes (AbsolutePathConverter).
const COMPILER_SETTINGS: ConfigurationFile = {
  name: 'compiler_settings.json',
  spelling: { separators: [{ first: '\\\\', rest: '\\\\' }], ends: '"', nativeStarts: ['"'] },
};

/** What Wabbajack's compiler asks of the mod manager. */
export interface ManagerAnswers {
  /** The folders the mod manager keeps that the compiler never ships. */
  readonly neverShipped: readonly string[];
  /** The mods `profile` enables, by name. */
  enabledMods(profile: string): Promise<readonly string[]>;
}

// The compiler applies Ignore first. It then drops a folder it never ships, and a mod no compile profile enables
// unless Always Enabled covers it, before the rest apply.
interface WabbajackTag {
  readonly listedUnder: string;
  readonly tag: PublisherTag;
  readonly appliedFirst: boolean;
  readonly enablesMod: boolean;
}

// In the order Wabbajack's compiler declares them.
const TAGS: readonly WabbajackTag[] = [
  { listedUnder: 'NoMatchInclude', tag: { name: 'No Match Include', badge: 'NM', marksPaths: true }, appliedFirst: false, enablesMod: false },
  { listedUnder: 'Include', tag: { name: 'Include', badge: 'IN', marksPaths: true }, appliedFirst: false, enablesMod: false },
  { listedUnder: 'Ignore', tag: { name: 'Ignore', badge: 'IG', marksPaths: true }, appliedFirst: true, enablesMod: false },
  { listedUnder: 'AlwaysEnabled', tag: { name: 'Always Enabled', badge: 'AE', marksPaths: false }, appliedFirst: false, enablesMod: true },
];

// A path relative to the instance as Wabbajack splits one: at either separator, an empty name dropped,
// each name compared without case.
const namesOf = (path: string): string[] => path.split(/[\\/]/).filter((name) => name !== '').map((name) => name.toLowerCase());

interface PathNode {
  readonly tags: Set<PublisherTag>;
  readonly below: Map<string, PathNode>;
}

const pathNode = (): PathNode => ({ tags: new Set(), below: new Map() });

// Each index of `chars` outside every string, in order; `visit` answers the index to go on from.
function outsideStrings(chars: readonly string[], visit: (at: number) => number): void {
  let inString = false;
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at];
    if (inString) {
      if (char === '\\') at++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else {
      at = visit(at);
    }
  }
}

const blank = (chars: string[], from: number, to: number): void => {
  for (let at = from; at < to; at++) if (chars[at] !== '\n') chars[at] = ' ';
};

// What Wabbajack's serializer skips, blanked so each position stays where it was: comments, and a comma before a
// closing bracket.
function blankedSkips(text: string): string {
  const chars = text.split('');
  outsideStrings(chars, (at) => {
    const opening = chars.slice(at, at + 2).join('');
    if (opening !== '//' && opening !== '/*') return at;
    const closing = opening === '//' ? '\n' : '*/';
    const end = text.indexOf(closing, at + 2);
    const to = end === -1 ? chars.length : end + (opening === '//' ? 0 : 2);
    blank(chars, at, to);
    return to - 1;
  });
  outsideStrings(chars, (at) => {
    if (chars[at] !== ',') return at;
    let next = at + 1;
    while (chars[next]?.trim() === '') next++;
    if (chars[next] === ']' || chars[next] === '}') chars[at] = ' ';
    return at;
  });
  return chars.join('');
}

function settingsIn(text: string, file: string): object {
  let settings: unknown;
  try {
    settings = JSON.parse(blankedSkips(text));
  } catch (err) {
    throw new Error(`${file} is not JSON: ${errorMessage(err)}`, { cause: err });
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error(`${file} holds no settings object`);
  return settings;
}

const isName = (value: unknown): value is string => typeof value === 'string';
const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every(isName);

function valueOf<T>(settings: object, key: string, file: string, wanted: [(value: unknown) => value is T, string]): T | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(settings, key)?.value;
  const [isWanted, saying] = wanted;
  if (value === undefined) return undefined;
  if (!isWanted(value)) throw new Error(`${file}: ${key} is not ${saying}`);
  return value;
}

function tagsByPath(settings: object, file: string): PathNode {
  const root = pathNode();
  for (const { listedUnder, tag } of TAGS) {
    for (const path of valueOf(settings, listedUnder, file, [isNames, 'a list of paths']) ?? []) {
      let node = root;
      for (const name of namesOf(path)) {
        const next = node.below.get(name) ?? pathNode();
        node.below.set(name, next);
        node = next;
      }
      node.tags.add(tag);
    }
  }
  return root;
}

// The compile profiles, as the compiler's AllProfiles lists them. While every one is blank, the compiler drops no mod.
async function shippedModsIn(settings: object, file: string, manager: ManagerAnswers): Promise<ReadonlySet<string> | 'every'> {
  const profile = valueOf(settings, 'Profile', file, [isName, 'a profile']) ?? '';
  const additional = valueOf(settings, 'AdditionalProfiles', file, [isNames, 'a list of profiles']) ?? [];
  const profiles = [...additional, profile].filter((name) => name.trim() !== '');
  if (profiles.length === 0) return 'every';
  const enabled = await Promise.all(profiles.map((name) => manager.enabledMods(name)));
  return new Set(enabled.flat().map((mod) => mod.toLowerCase()));
}

// A publisher tag covers the path it names and every path in it.
function coveringIn(instanceRoot: string, root: PathNode, neverShipped: readonly (readonly string[])[], shippedMods: ReadonlySet<string> | 'every'): Covering {
  const isShipped = (mod: string | undefined, covers: readonly WabbajackTag[]): boolean =>
    mod === undefined || shippedMods === 'every' || shippedMods.has(mod.toLowerCase()) || covers.some(({ enablesMod }) => enablesMod);
  return (path, mod) => {
    const inInstance = relative(instanceRoot, path);
    if (inInstance.split(sep)[0] === '..') return [];
    const names = namesOf(inInstance);
    const found = new Set(root.tags);
    let at: PathNode | undefined = root;
    for (const name of names) {
      at = at.below.get(name);
      if (at === undefined) break;
      for (const tag of at.tags) found.add(tag);
    }
    const covers = TAGS.filter(({ tag }) => found.has(tag));
    if (covers.some(({ appliedFirst }) => appliedFirst)) return covers.flatMap(({ tag, appliedFirst }) => (appliedFirst ? [tag] : []));
    if (neverShipped.some((folder) => folder.every((name, depth) => names[depth] === name))) return [];
    return isShipped(mod, covers) ? covers.map(({ tag }) => tag) : [];
  };
}

export function wabbajackPublisher(instanceRoot: string, manager: ManagerAnswers): Publisher {
  const file = join(instanceRoot, COMPILER_SETTINGS.name);
  const neverShipped = manager.neverShipped.map((folder) => namesOf(relative(instanceRoot, folder)));
  const read = async (text: string): Promise<PublisherConfiguration> => {
    const settings = settingsIn(text, file);
    const tags = tagsByPath(settings, file);
    return { kind: 'read', covering: coveringIn(instanceRoot, tags, neverShipped, await shippedModsIn(settings, file, manager)) };
  };
  return {
    tags: TAGS.map(({ tag }) => tag),
    configurationFile: COMPILER_SETTINGS,
    configuration: async (): Promise<PublisherConfiguration> => {
      try {
        const text = await readOrAbsent(() => get(file), undefined);
        return text === undefined ? { kind: 'none' } : await read(text);
      } catch (err) {
        return { kind: 'unreadable', reason: errorMessage(err) };
      }
    },
    subscribe: (listener) => watchFiles(instanceRoot, COMPILER_SETTINGS.name, () => listener()),
  };
}
