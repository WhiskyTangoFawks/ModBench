// Wabbajack's implementation of the Instance adapter as a publisher (ADR-0024): the publisher tags its
// compiler settings hold, as its compiler applies them, and never a mod's metadata (publishing.md,
// Publisher tags, story 5).

import { isAbsolute, join, relative, sep } from 'node:path';
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, type Edit, type FormattingOptions, type ParseError } from 'jsonc-parser';
import { errnoCode } from '../errno';
import { errorMessage } from '../../ports/errorMessage';
import { get, listDir, putIfChanged, readOrAbsent } from '../files';
import type { Covering, Listed, PathRefusal, PublisherConfiguration, PublisherTag, PublisherTagChange, TagPathProblem } from '../instanceAdapter';
import type { ConfigurationFile, Publisher } from '../publisher';
import { sedSubstitution } from '../pathTokens';
import { watchFiles } from '../watchFiles';

// Wabbajack's configuration, at the instance root. Wabbajack writes this machine's own paths, or on Wine a Windows
// program's, a Windows one in JSON's escaped backslashes (AbsolutePathConverter).
const COMPILER_SETTINGS: ConfigurationFile = {
  name: 'compiler_settings.json',
  spelling: { separators: [{ first: '\\\\', rest: '\\\\' }], ends: '"', nativeStarts: ['"'] },
  // The compiler's output is chosen at each compile, and Wabbajack's GUI asks for one when it is empty.
  blanked: { clean: [sedSubstitution(String.raw`\("OutputFile" *: *\)"\(\\.\|[^"\\]\)*"`, '\\1""')], smudge: [] },
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

// A publisher tag covers the path it names and every path in it.
function coveringIn(instanceRoot: string, root: PathNode, neverShipped: readonly (readonly string[])[], shippedMods: ReadonlySet<string> | 'every'): Covering {
  const isShipped = (mod: string | undefined, covers: readonly WabbajackTag[]): boolean =>
    mod === undefined || shippedMods === 'every' || shippedMods.has(mod.toLowerCase()) || covers.some(({ enablesMod }) => enablesMod);
  return (path, mod) => {
    const inside = inInstance(instanceRoot, path);
    if (inside === undefined) return [];
    const names = namesOf(inside);
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

// What a rewrite of one list does to the entries it holds: each keeps its place, takes another entry's, or goes;
// then the new ones follow.
interface ListChange {
  readonly slots: readonly (string | undefined)[];
  readonly appended: readonly string[];
}

const isUnder = (names: readonly string[], folder: readonly string[]): boolean => folder.every((name, depth) => names[depth] === name);

const sameNames = (first: readonly string[], second: readonly string[]): boolean =>
  first.length === second.length && first.every((name, at) => name === second[at]);

const wabbajackSpelling = (inside: string): string => inside.split(sep).join('\\');

function changedEntries(entries: readonly string[], change: PublisherTagChange, insides: readonly string[]): ListChange {
  const named = (entry: string): boolean => insides.some((inside) => sameNames(namesOf(inside), namesOf(entry)));
  if (change === 'remove') return { slots: entries.map((entry) => (named(entry) ? undefined : entry)), appended: [] };
  const appended: string[] = [];
  for (const inside of insides) {
    const listed = [...entries, ...appended].some((entry) => sameNames(namesOf(entry), namesOf(inside)));
    if (!listed) appended.push(wabbajackSpelling(inside));
  }
  return { slots: entries, appended };
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
  const slots = entries.map((entry) => {
    const move = moveOf(entry);
    if (move === undefined) return entry;
    if (move.to === undefined) return undefined;
    const rest = entry.split(/[\\/]/).filter((name) => name !== '').slice(move.from.length);
    const followed = [move.to, ...rest].join('\\');
    const key = namesOf(followed).join('/');
    if (listed.has(key)) return undefined;
    listed.add(key);
    return followed;
  });
  return { slots, appended: [] };
}

// A file's own indentation and line ends, which an edit of its text keeps.
function formatOf(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const tabbed = indent.startsWith('\t');
  return { insertSpaces: !tabbed, tabSize: tabbed ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

// Takes an entry out with its comma and its line, leaving any comment that trails it.
function withoutEntry(text: string, key: string, at: number): string {
  const root = parseTree(text, [], READS);
  const entries = (root === undefined ? undefined : findNodeAtLocation(root, [key]))?.children;
  const entry = entries?.[at];
  if (entry === undefined) throw new Error(`no entry ${at} in ${key}`);
  const afterBlank = (from: number): number => from + (/^\s*/.exec(text.slice(from))?.[0].length ?? 0);
  const previous = entries?.[at - 1];
  const edits: Edit[] = [];
  let start = entry.offset;
  let end = entry.offset + entry.length;
  if (text[afterBlank(end)] === ',') end = afterBlank(end) + 1;
  else if (previous !== undefined && text[afterBlank(previous.offset + previous.length)] === ',') {
    edits.push({ offset: afterBlank(previous.offset + previous.length), length: 1, content: '' });
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(lineStart, start).trim() === '') {
    start = lineStart;
    end += /^[ \t]*\r?\n/.exec(text.slice(end))?.[0].length ?? 0;
  }
  edits.push({ offset: start, length: end - start, content: '' });
  return applyEdits(text, edits);
}

// Edits the list the read takes, the last of a key listed twice, and nothing else. Alone in a document, it is the only one.
function withListChanged(text: string, key: string, entries: readonly string[] | undefined, change: ListChange): string {
  const read = parseTree(text, [], READS)?.children?.findLast((property) => property.children?.[0]?.value === key)?.children?.[1];
  if (read === undefined) return withFirstListChanged(text, key, entries, change);
  const { insertSpaces, tabSize, eol } = formatOf(text);
  const head = `{${eol}${insertSpaces ? ' '.repeat(tabSize ?? 2) : '\t'}${JSON.stringify(key)}: `;
  const tail = `${eol}}`;
  const alone = `${head}${text.slice(read.offset, read.offset + read.length)}${tail}`;
  const edited = withFirstListChanged(alone, key, entries, change);
  return text.slice(0, read.offset) + edited.slice(head.length, edited.length - tail.length) + text.slice(read.offset + read.length);
}

function withFirstListChanged(text: string, key: string, entries: readonly string[] | undefined, { slots, appended }: ListChange): string {
  const formattingOptions = formatOf(text);
  const edit = (now: string, path: (string | number)[], value: unknown, isArrayInsertion = false): string =>
    applyEdits(now, modify(now, path, value, { formattingOptions, isArrayInsertion }));
  if (entries === undefined) return appended.length === 0 ? text : edit(text, [key], appended);
  let after = text;
  for (let at = entries.length - 1; at >= 0; at--) {
    const now = slots[at];
    if (now === entries[at]) continue;
    after = now === undefined ? withoutEntry(after, key, at) : edit(after, [key, at], now);
  }
  for (const entry of appended) after = edit(after, [key, -1], entry, true);
  return after;
}

export function wabbajackPublisher(instanceRoot: string, manager: ManagerAnswers): Publisher {
  const file = join(instanceRoot, COMPILER_SETTINGS.name);
  const neverShipped = manager.neverShipped.map((folder) => namesOf(relative(instanceRoot, folder)));
  const understood = async (text: string) => {
    const settings = settingsIn(text, file);
    const tags = tagsByPath(settings, file);
    return { settings, tags, covering: coveringIn(instanceRoot, tags, neverShipped, await shippedModsIn(settings, file, manager)) };
  };
  const settingsText = () => readOrAbsent(() => get(file), undefined);
  return {
    tags: TAGS.map(({ tag }) => tag),
    configurationFile: COMPILER_SETTINGS,
    configuration: async (): Promise<PublisherConfiguration> => {
      try {
        const text = await settingsText();
        if (text === undefined) return { kind: 'none' };
        const { settings, tags, covering } = await understood(text);
        return { kind: 'read', covering, listed: listedIn(instanceRoot, tags), pathProblems: await tagsWithPathProblems(instanceRoot, settings, text, file) };
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
        const entries = valueOf(settingsIn(before, file), listedUnder, file, [isNames, 'a list of paths']);
        return withListChanged(before, listedUnder, entries, changedEntries(entries ?? [], change, insides));
      });
      return refused;
    },
    followFolders: async (moves) => {
      const inside = moves.flatMap(({ from, to }) => {
        const fromInside = inInstance(instanceRoot, from);
        const toInside = to === undefined ? undefined : inInstance(instanceRoot, to);
        return fromInside === undefined ? [] : [{ from: namesOf(fromInside), to: toInside?.split(sep).join('\\') }];
      });
      await putIfChanged(file, (before) => {
        const settings = settingsIn(before, file);
        return TAGS.reduce((text, { listedUnder }) => {
          const entries = valueOf(settings, listedUnder, file, [isNames, 'a list of paths']);
          return withListChanged(text, listedUnder, entries, followedEntries(entries ?? [], inside));
        }, before);
      }, { ifMissing: '{}' });
    },
    keepOut: async ({ present, owns }) => {
      if (await readOrAbsent(() => get(file), undefined) === undefined) return () => Promise.resolve();
      const insides = present.flatMap((path) => inInstance(instanceRoot, path) ?? []);
      const isGone = (entry: string): boolean => owns(join(instanceRoot, ...namesOf(entry))) && !insides.some((inside) => sameNames(namesOf(inside), namesOf(entry)));
      let written: { before: string; after: string } | undefined;
      await putIfChanged(file, (before) => {
        const entries = valueOf(settingsIn(before, file), 'Ignore', file, [isNames, 'a list of paths']);
        const slots = (entries ?? []).map((entry) => (isGone(entry) ? undefined : entry));
        const remaining = slots.filter((entry) => entry !== undefined);
        const missing = insides.filter((inside) => !remaining.some((entry) => isUnder(namesOf(inside), namesOf(entry))));
        const after = withListChanged(before, 'Ignore', entries, { slots, appended: missing.map(wabbajackSpelling) });
        if (after !== before) written = { before, after };
        return after;
      });
      return async () => {
        if (written === undefined) return;
        const { before, after } = written;
        await putIfChanged(file, (text) => (text === after ? before : text));
      };
    },
    subscribe: (listener) => watchFiles(instanceRoot, COMPILER_SETTINGS.name, () => listener()),
  };
}
