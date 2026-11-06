// Wabbajack's implementation of the Instance adapter as a publisher (ADR-0024): the publisher tags its
// compiler settings hold, as its compiler applies them, and never a mod's metadata (publishing.md,
// Publisher tags, story 5).

import { isAbsolute, join, relative, sep } from 'node:path';
import { applyEdits, parse, parseTree, printParseErrorCode, type Edit, type Node, type ParseError } from 'jsonc-parser';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { get, listDir, putIfChanged, readOrAbsent } from '../files';
import type { Covering, Listed, PathRefusal, PublisherConfiguration, PublisherTag, PublisherTagChange, TagPathProblem, UnshippableReason } from '../instanceAdapter';
import type { ConfigurationFile, Publisher } from '../publisher';
import { sedReplacement, sedSubstitution } from '../pathTokens';
import { watchFiles } from '../watchFiles';
import { heldTextAt, placeIn, samePath } from '../../symbolNames/symbolNames';

// Wabbajack's configuration, at the instance root. Wabbajack writes this machine's own paths, or on Wine a Windows
// program's, a Windows one in JSON's escaped backslashes (AbsolutePathConverter).
const COMPILER_SETTINGS: ConfigurationFile = {
  name: 'compiler_settings.json',
  spelling: { separators: [{ first: '\\\\', rest: '\\\\' }], ends: '"', nativeStarts: ['"'] },
  // The compiler's output is chosen at each compile, and Wabbajack's GUI asks for one when it is empty.
  blanked: (thisMachine) => {
    const output = /"OutputFile" *: *("(?:\\.|[^"\\])*")/.exec(thisMachine)?.[1];
    return {
      clean: [sedSubstitution(String.raw`\("OutputFile" *: *\)"\(\\.\|[^"\\]\)*"`, '\\1""')],
      smudge: output === undefined || output === '""' ? [] : [sedSubstitution(String.raw`\("OutputFile" *: *\)""`, `\\1${sedReplacement(output)}`)],
    };
  },
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
  /** Whether it ships a file no download matches. */
  readonly shipsUnmatched: boolean;
}

// In the order Wabbajack's compiler declares them.
const TAGS: readonly WabbajackTag[] = [
  { listedUnder: 'NoMatchInclude', tag: { name: 'No Match Include', badge: 'NM', marksPaths: true }, appliedFirst: false, enablesMod: false, shipsUnmatched: true },
  { listedUnder: 'Include', tag: { name: 'Include', badge: 'IN', marksPaths: true }, appliedFirst: false, enablesMod: false, shipsUnmatched: true },
  { listedUnder: 'Ignore', tag: { name: 'Ignore', badge: 'IG', marksPaths: true }, appliedFirst: true, enablesMod: false, shipsUnmatched: false },
  { listedUnder: 'AlwaysEnabled', tag: { name: 'Always Enabled', badge: 'AE', marksPaths: false }, appliedFirst: false, enablesMod: true, shipsUnmatched: false },
];

// A path relative to the instance as Wabbajack splits one: at either separator, an empty name dropped,
// each name compared without case.
const namesOf = (path: string): string[] => path.split(/[\\/]/).filter((name) => name !== '').map((name) => name.toLowerCase());

interface PathNode {
  readonly tags: Set<PublisherTag>;
  readonly below: Map<string, PathNode>;
}

const pathNode = (): PathNode => ({ tags: new Set(), below: new Map() });

// As Wabbajack's serializer reads it: comments and a comma before a closing bracket are skipped.
const READS = { allowTrailingComma: true };

function settingsIn(text: string, file: string): object {
  const errors: ParseError[] = [];
  const settings: unknown = parse(text, errors, READS);
  const [first] = errors;
  if (first !== undefined) {
    const before = text.slice(0, first.offset).split('\n');
    throw new Error(`${file} is not JSON: ${printParseErrorCode(first.error)} at line ${before.length}, column ${(before.at(-1) ?? '').length + 1}`);
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

// A key listed twice keeps its last, as the parse does.
function entryLines(text: string): Map<string, number[]> {
  const lines = new Map<string, number[]>();
  for (const property of parseTree(text, [], READS)?.children ?? []) {
    const [key, list] = property.children ?? [];
    lines.set(String(key?.value), (list?.children ?? []).map((entry) => text.slice(0, entry.offset).split('\n').length));
  }
  return lines;
}

type Listings = Map<string, Promise<ReadonlyMap<string, string> | undefined>>;

// Whether the instance holds a file or folder at `names`, each compared without case.
async function holdsPath(instanceRoot: string, names: readonly string[], listings: Listings): Promise<boolean> {
  let folder = instanceRoot;
  for (const name of names) {
    const listed = folder;
    const listing = listings.get(listed) ?? listDir(listed).then(
      (entries) => new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.name])),
      (err: unknown) => {
        if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return undefined;
        throw err;
      },
    );
    listings.set(listed, listing);
    const actual = (await listing)?.get(name);
    if (actual === undefined) return false;
    folder = join(folder, actual);
  }
  return true;
}

async function problemWith(instanceRoot: string, entry: string, listings: Listings): Promise<'namesNoPath' | { reason: string } | undefined> {
  try {
    return await holdsPath(instanceRoot, namesOf(entry), listings) ? undefined : 'namesNoPath';
  } catch (err) {
    return { reason: errorMessage(err) };
  }
}

async function tagsWithPathProblems(instanceRoot: string, settings: object, text: string, file: string): Promise<TagPathProblem[]> {
  const lines = entryLines(text);
  const listings: Listings = new Map();
  const problems: TagPathProblem[] = [];
  for (const { listedUnder, tag } of TAGS) {
    const entries = valueOf(settings, listedUnder, file, [isNames, 'a list of paths']) ?? [];
    for (const [at, entry] of entries.entries()) {
      const problem = await problemWith(instanceRoot, entry, listings);
      const line = lines.get(listedUnder)?.[at];
      if (line === undefined) throw new Error(`${file}: no line for ${listedUnder} entry ${at}`);
      if (problem === 'namesNoPath') problems.push({ kind: 'namesNoPath', file, line, tag, entry });
      else if (problem !== undefined) problems.push({ kind: 'notChecked', file, line, tag, entry, reason: problem.reason });
    }
  }
  return problems;
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

function inInstance(instanceRoot: string, path: string): string | undefined {
  const inside = relative(instanceRoot, path);
  return isAbsolute(inside) || inside.split(sep)[0] === '..' ? undefined : inside;
}

function listedIn(instanceRoot: string, root: PathNode): Listed {
  return (path) => {
    const inside = inInstance(instanceRoot, path);
    if (inside === undefined) return [];
    let at: PathNode | undefined = root;
    for (const name of namesOf(inside)) at = at?.below.get(name);
    const found = at?.tags ?? new Set<PublisherTag>();
    return TAGS.filter(({ tag }) => found.has(tag)).map(({ tag }) => tag);
  };
}

interface Compiled {
  /** Each publisher tag that covers the path, in the order the compiler declares them. */
  readonly covers: readonly WabbajackTag[];
  /** Whether the compiler gets past Ignore, a folder it never ships and a mod no profile enables, to the rest. */
  readonly reached: boolean;
}

// A publisher tag covers the path it names and every path in it.
function compiledIn(instanceRoot: string, root: PathNode, neverShipped: readonly (readonly string[])[], shippedMods: ReadonlySet<string> | 'every') {
  const isShipped = (mod: string | undefined, covers: readonly WabbajackTag[]): boolean =>
    mod === undefined || shippedMods === 'every' || shippedMods.has(mod.toLowerCase()) || covers.some(({ enablesMod }) => enablesMod);
  return (path: string, mod: string | undefined): Compiled | undefined => {
    const inside = inInstance(instanceRoot, path);
    if (inside === undefined) return undefined;
    const names = namesOf(inside);
    const found = new Set(root.tags);
    let at: PathNode | undefined = root;
    for (const name of names) {
      at = at.below.get(name);
      if (at === undefined) break;
      for (const tag of at.tags) found.add(tag);
    }
    const covers = TAGS.filter(({ tag }) => found.has(tag));
    if (covers.some(({ appliedFirst }) => appliedFirst)) return { covers: covers.filter(({ appliedFirst }) => appliedFirst), reached: false };
    const reached = !neverShipped.some((folder) => folder.every((name, depth) => names[depth] === name)) && isShipped(mod, covers);
    return { covers, reached };
  };
}

const coveringIn = (compiled: ReturnType<typeof compiledIn>): Covering => (path, mod) => {
  const judged = compiled(path, mod);
  return judged === undefined || !(judged.reached || judged.covers.some(({ appliedFirst }) => appliedFirst)) ? [] : judged.covers.map(({ tag }) => tag);
};

const UNSHIPPABLE = 'no package holds its bytes, and no Include or No Match Include publisher tag covers it';

const unshippableIn = (compiled: ReturnType<typeof compiledIn>): UnshippableReason => (folder, pathInFolder, mod) => {
  const judged = compiled(join(folder, pathInFolder), mod);
  return judged?.reached === true && !judged.covers.some(({ shipsUnmatched }) => shipsUnmatched) ? UNSHIPPABLE : undefined;
};

interface ListChange {
  readonly changed: ReadonlyMap<number, string | undefined>;
  readonly appended: readonly string[];
}

const isUnder = (names: readonly string[], folder: readonly string[]): boolean => folder.every((name, depth) => names[depth] === name);

// Whether `names` lie under, or at, one of the paths whose names `folders` holds joined.
const isUnderAnyOf = (names: readonly string[], folders: ReadonlySet<string>): boolean =>
  Array.from({ length: names.length + 1 }, (_, depth) => names.slice(0, depth).join('/')).some((prefix) => folders.has(prefix));

const sameNames = (first: readonly string[], second: readonly string[]): boolean =>
  first.length === second.length && first.every((name, at) => name === second[at]);

const wabbajackSpelling = (inside: string): string => inside.split(sep).join('\\');

function changedEntries(entries: readonly string[], change: PublisherTagChange, insides: readonly string[]): ListChange {
  const named = (entry: string): boolean => insides.some((inside) => sameNames(namesOf(inside), namesOf(entry)));
  if (change === 'remove') return { changed: new Map(entries.flatMap((entry, at) => (named(entry) ? [[at, undefined] as const] : []))), appended: [] };
  const appended: string[] = [];
  for (const inside of insides) {
    const listed = [...entries, ...appended].some((entry) => sameNames(namesOf(entry), namesOf(inside)));
    if (!listed) appended.push(wabbajackSpelling(inside));
  }
  return { changed: new Map(), appended };
}

interface InstanceMove {
  readonly from: readonly string[];
  readonly to: string | undefined;
}

function followedEntries(entries: readonly string[], moves: readonly InstanceMove[]): ListChange {
  const moveOf = (entry: string): InstanceMove | undefined => {
    const names = namesOf(entry);
    return moves.find(({ from }) => isUnder(names, from));
  };
  const listed = new Set(entries.filter((entry) => moveOf(entry) === undefined).map((entry) => namesOf(entry).join('/')));
  const changed = new Map<number, string | undefined>();
  for (const [at, entry] of entries.entries()) {
    const move = moveOf(entry);
    if (move === undefined) continue;
    const rest = entry.split(/[\\/]/).filter((name) => name !== '').slice(move.from.length);
    const followed = move.to === undefined ? undefined : [move.to, ...rest].join('\\');
    const key = followed === undefined ? undefined : namesOf(followed).join('/');
    if (key === undefined || listed.has(key)) {
      changed.set(at, undefined);
    } else {
      listed.add(key);
      changed.set(at, followed);
    }
  }
  return { changed, appended: [] };
}

interface Segment {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

// The names of an entry's path where the text spells them, at either separator as the JSON spells it.
function segmentsOf(text: string, entry: Node): Segment[] {
  const first = entry.offset + 1;
  const raw = text.slice(first, entry.offset + entry.length - 1);
  const segments: Segment[] = [];
  let from = 0;
  const closeAt = (to: number): void => {
    if (to > from) segments.push({ name: raw.slice(from, to), start: first + from, end: first + to });
  };
  for (const separator of raw.matchAll(/\\\\|\\\/|\//g)) {
    closeAt(separator.index);
    from = separator.index + separator[0].length;
  }
  closeAt(raw.length);
  return segments;
}

// Each entry of every list of tags, as the segments it spells.
function entrySegmentsIn(text: string): Segment[][] {
  return (parseTree(text, [], READS)?.children ?? []).flatMap((property) => {
    const [key, list] = property.children ?? [];
    if (!TAGS.some(({ listedUnder }) => listedUnder === key?.value)) return [];
    return (list?.children ?? []).flatMap((entry) => (entry.type === 'string' ? [segmentsOf(text, entry)] : []));
  });
}

function layoutOf(text: string): { eol: string; unit: string } {
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', unit: /\n([ \t]+)"/.exec(text)?.[1] ?? '  ' };
}

// The list the read takes: the last of a key listed twice.
const listOf = (text: string, key: string): Node | undefined =>
  parseTree(text, [], READS)?.children?.findLast((property) => property.children?.[0]?.value === key)?.children?.[1];

const SKIPPED = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\//y;

function afterSkipped(text: string, from: number): number {
  let at = from;
  for (;;) {
    SKIPPED.lastIndex = at;
    const skipped = SKIPPED.exec(text);
    if (skipped === null) return at;
    at += skipped[0].length;
  }
}

function commaFrom(text: string, from: number): number | undefined {
  const at = afterSkipped(text, from);
  return text[at] === ',' ? at : undefined;
}

const lineStartOf = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;

function withoutEntry(text: string, list: Node, at: number): string {
  const entry = list.children?.[at];
  const previous = list.children?.[at - 1];
  if (entry === undefined) throw new Error(`no entry ${at}`);
  const end = entry.offset + entry.length;
  const own = commaFrom(text, end);
  const separator = own ?? (previous === undefined ? undefined : commaFrom(text, previous.offset + previous.length));
  const bare = own === undefined || text.slice(end, own).trim() === '';
  const tail = own !== undefined && bare ? own + 1 : end;
  const lineStart = lineStartOf(text, entry.offset);
  const lineEnd = /^[ \t]*\r?\n/.exec(text.slice(tail))?.[0];
  const whole = bare && lineEnd !== undefined && text.slice(lineStart, entry.offset).trim() === '';
  const edits: Edit[] = whole
    ? [{ offset: lineStart, length: tail + lineEnd.length - lineStart, content: '' }]
    : [{ offset: entry.offset, length: entry.length, content: '' }];
  if (separator !== undefined && !(whole && own !== undefined)) edits.push({ offset: separator, length: 1, content: '' });
  return applyEdits(text, edits);
}

function insertIntoEmpty(text: string, container: Node, item: string): string {
  const { eol, unit } = layoutOf(text);
  const multiline = text.slice(container.offset, container.offset + container.length).includes('\n');
  const lineStart = lineStartOf(text, container.offset);
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
  const content = multiline ? `${eol}${indent}${unit}${item}` : item;
  return applyEdits(text, [{ offset: container.offset + 1, length: 0, content }]);
}

function withAppended(text: string, key: string, value: string): string {
  const list = listOf(text, key);
  const entry = JSON.stringify(value);
  if (list === undefined) {
    const root = parseTree(text, [], READS);
    if (root === undefined) throw new Error('no settings object');
    const lastProperty = root.children?.at(-1);
    const { eol, unit } = layoutOf(text);
    const indent = lastProperty === undefined ? unit : /^[ \t]*/.exec(text.slice(lineStartOf(text, lastProperty.offset)))?.[0] ?? '';
    const property = text.includes('\n')
      ? `${JSON.stringify(key)}: [${eol}${indent}${unit}${entry}${eol}${indent}]`
      : `${JSON.stringify(key)}: [ ${entry} ]`;
    return lastProperty === undefined ? insertIntoEmpty(text, root, property) : insertAfter(text, lastProperty, property);
  }
  const last = list.children?.at(-1);
  return last === undefined ? insertIntoEmpty(text, list, entry) : insertAfter(text, last, entry);
}

function insertAfter(text: string, last: Node, entry: string): string {
  const end = last.offset + last.length;
  const own = commaFrom(text, end);
  const from = own === undefined ? end : own + 1;
  const lineEnd = text.indexOf('\n', from);
  const lineEndAt = lineEnd > 0 && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
  const indent = text.slice(lineStartOf(text, last.offset), last.offset);
  const ownLine = lineEnd !== -1 && indent.trim() === '' && afterSkipped(text.slice(0, lineEndAt), from) === lineEndAt;
  if (!ownLine) return applyEdits(text, [{ offset: end, length: 0, content: `, ${entry}` }]);
  const comma = own === undefined ? ',' : '';
  const line = `${layoutOf(text).eol}${indent}${entry}${own === undefined ? '' : ','}`;
  const edits: Edit[] = lineEndAt === end
    ? [{ offset: end, length: 0, content: comma + line }]
    : [{ offset: end, length: 0, content: comma }, { offset: lineEndAt, length: 0, content: line }];
  return applyEdits(text, edits);
}

function withListChanged(text: string, key: string, change: ListChange): string {
  let after = text;
  for (const at of [...change.changed.keys()].sort((a, b) => b - a)) {
    const list = listOf(after, key);
    const entry = list?.children?.[at];
    if (list === undefined || entry === undefined) throw new Error(`${key} holds no entry ${at}`);
    const now = change.changed.get(at);
    after = now === undefined ? withoutEntry(after, list, at) : applyEdits(after, [{ offset: entry.offset, length: entry.length, content: JSON.stringify(now) }]);
  }
  for (const value of change.appended) after = withAppended(after, key, value);
  return after;
}

export function wabbajackPublisher(instanceRoot: string, manager: ManagerAnswers): Publisher {
  const file = join(instanceRoot, COMPILER_SETTINGS.name);
  const neverShipped = manager.neverShipped.map((folder) => namesOf(relative(instanceRoot, folder)));
  let judging: { readonly key: string; readonly tags: PathNode; readonly covering: Covering; readonly reason: UnshippableReason } | undefined;
  const understood = async (text: string) => {
    const settings = settingsIn(text, file);
    const shipped = await shippedModsIn(settings, file, manager);
    const key = JSON.stringify([text, shipped === 'every' ? shipped : [...shipped].sort()]);
    if (judging?.key !== key) {
      const tags = tagsByPath(settings, file);
      const compiled = compiledIn(instanceRoot, tags, neverShipped, shipped);
      judging = { key, tags, covering: coveringIn(compiled), reason: unshippableIn(compiled) };
    }
    return { settings, ...judging };
  };
  const settingsText = () => readOrAbsent(() => get(file), undefined);
  return {
    tags: TAGS.map(({ tag }) => tag),
    configurationFile: COMPILER_SETTINGS,
    configuration: async (): Promise<PublisherConfiguration> => {
      try {
        const text = await settingsText();
        if (text === undefined) return { kind: 'none' };
        const { settings, tags, covering, reason } = await understood(text);
        return {
          kind: 'read', covering, listed: listedIn(instanceRoot, tags), pathProblems: await tagsWithPathProblems(instanceRoot, settings, text, file),
          unshippable: { file, reason },
        };
      } catch (err) {
        return { kind: 'unreadable', reason: errorMessage(err) };
      }
    },
    refusal: async () => {
      try {
        const text = await settingsText();
        if (text !== undefined) await understood(text);
        return undefined;
      } catch (err) {
        return errorMessage(err);
      }
    },
    namesFolder: async (folder, held) => {
      const inside = inInstance(instanceRoot, folder);
      try {
        const text = heldTextAt(held, file) ?? await settingsText();
        if (text === undefined || inside === undefined) return { references: [], leftOut: [] };
        settingsIn(text, file);
        const names = namesOf(inside);
        const references = entrySegmentsIn(text).flatMap((segments) => {
          const named = segments[names.length - 1];
          return isUnder(segments.map(({ name }) => name.toLowerCase()), names) && named !== undefined ? [placeIn(file, text, named.start, named.end)] : [];
        });
        return { references, leftOut: [] };
      } catch (err) {
        return { references: [], leftOut: [errorMessage(err)] };
      }
    },
    folderAt: (named, text, offset) => {
      if (!samePath(named, file)) return undefined;
      for (const segments of entrySegmentsIn(text)) {
        const at = segments.findIndex(({ start, end }) => start <= offset && offset <= end);
        if (at !== -1) return segments.slice(0, at + 1).map(({ name }) => name);
      }
      return undefined;
    },
    changeTag: async (change, tagName, paths) => {
      const wabbajackTag = TAGS.find(({ tag }) => tag.name === tagName);
      if (wabbajackTag === undefined) throw new Error(`Wabbajack declares no publisher tag "${tagName}"`);
      const { listedUnder } = wabbajackTag;
      const refused: PathRefusal[] = [];
      const insides = paths.flatMap((path) => {
        const inside = inInstance(instanceRoot, path);
        if (inside === undefined) refused.push({ path, reason: 'It is outside the instance.' });
        return inside === undefined ? [] : [inside];
      });
      await putIfChanged(file, (before) => {
        const entries = valueOf(settingsIn(before, file), listedUnder, file, [isNames, 'a list of paths']) ?? [];
        return withListChanged(before, listedUnder, changedEntries(entries, change, insides));
      });
      return refused;
    },
    followFolders: async (moves) => {
      const inside = moves.flatMap(({ from, to }) => {
        const fromInside = inInstance(instanceRoot, from);
        const toInside = to === undefined ? undefined : inInstance(instanceRoot, to);
        return fromInside === undefined ? [] : [{ from: namesOf(fromInside), to: toInside === undefined ? undefined : wabbajackSpelling(toInside) }];
      });
      await putIfChanged(file, (before) => {
        const settings = settingsIn(before, file);
        return TAGS.reduce((text, { listedUnder }) => {
          const entries = valueOf(settings, listedUnder, file, [isNames, 'a list of paths']) ?? [];
          return withListChanged(text, listedUnder, followedEntries(entries, inside));
        }, before);
      }, { ifMissing: '{}' });
    },
    keepOut: async ({ present, owns }) => {
      if (await readOrAbsent(() => get(file), undefined) === undefined) return;
      const insides = present.flatMap((path) => inInstance(instanceRoot, path) ?? []);
      const insideKeys = new Set(insides.map((inside) => namesOf(inside).join('/')));
      const isGone = (entry: string): boolean => {
        const names = namesOf(entry);
        return owns(join(instanceRoot, ...names)) && !insideKeys.has(names.join('/'));
      };
      await putIfChanged(file, (before) => {
        const entries = valueOf(settingsIn(before, file), 'Ignore', file, [isNames, 'a list of paths']) ?? [];
        const changed = new Map(entries.flatMap((entry, at) => (isGone(entry) ? [[at, undefined] as const] : [])));
        const remaining = entries.filter((_, at) => !changed.has(at));
        const remainingKeys = new Set(remaining.map((entry) => namesOf(entry).join('/')));
        const missing = insides.filter((inside) => !isUnderAnyOf(namesOf(inside), remainingKeys));
        return withListChanged(before, 'Ignore', { changed, appended: missing.map(wabbajackSpelling) });
      });
    },
    subscribe: (listener) => watchFiles(instanceRoot, COMPILER_SETTINGS.name, listener),
  };
}
