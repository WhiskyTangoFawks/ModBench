import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, stringify, type Document, type YAMLMap, type YAMLSeq } from 'yaml';

type SortingRuleFile = { readonly path: string } & (
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string }
);

export interface SortingRuleFiles {
  readonly masterlist: SortingRuleFile;
  readonly prelude: SortingRuleFile;
  readonly userlist: SortingRuleFile;
}

export type RuleFileName = keyof SortingRuleFiles;

/** Where a rule was stated: a file, and its zero-based line. */
export interface RuleSource {
  file: 'masterlist' | 'userlist';
  line: number;
}

export interface LootFile {
  name: string;
  display?: string;
  detail?: string;
  condition?: string;
  source: RuleSource;
}

/** The group a plugin with none is in; every file declares it. */
export const DEFAULT_GROUP = 'default';

export type RuleLevel = 'error' | 'warning' | 'info';

interface LootMessage {
  level: RuleLevel;
  text: string;
  condition?: string;
  source: RuleSource;
}

export interface LootGroup {
  name: string;
  after: { name: string; source: RuleSource }[];
}

export interface LootEntry {
  name: string;
  group?: { name: string; source: RuleSource };
  exact: boolean;
  matches: (filename: string) => boolean;
  req: LootFile[];
  inc: LootFile[];
  after: LootFile[];
  msg: LootMessage[];
}

/** A sorting rule file that does not read, or a part of it that does not. `line` is zero-based, absent for a whole file. */
export interface RuleFileProblem {
  file: RuleFileName;
  line?: number;
  text: string;
}

const MESSAGE_LEVELS: Record<string, RuleLevel> = { say: 'info', warn: 'warning', error: 'error' };

// LOOT reads a name holding any of these as a regular expression over the whole file name.
const REGEX_NAME = /[:\\*?|]/;

// The largest real masterlist with its prelude resolves 368 aliases; a file that needs far more is an alias bomb.
const MAX_ALIASES = 4000;

const PRELUDE_KEY = /^prelude:[ \t]*(#.*)?$/;
const NEXT_TOP_LEVEL_KEY = /^[^\s#]/;

interface Substitution {
  startLine: number;
  oldLines: number;
  newLines: number;
}

// LOOT replaces the masterlist's `prelude:` value with the prelude file, so the anchors the masterlist uses resolve.
function withPrelude(masterlist: string, prelude: string): { text: string; substitution: Substitution } | undefined {
  const lines = masterlist.split('\n');
  const key = lines.findIndex((line) => PRELUDE_KEY.test(line.replace(/\r$/, '')));
  if (key === -1) return undefined;
  const next = lines.findIndex((line, index) => index > key && NEXT_TOP_LEVEL_KEY.test(line));
  const end = next === -1 ? lines.length : next;
  const indented = prelude.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map((line) => (line === '' ? line : `  ${line}`));
  return {
    text: [...lines.slice(0, key + 1), ...indented, ...lines.slice(end)].join('\n'),
    substitution: { startLine: key + 1, oldLines: end - key - 1, newLines: indented.length },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function contentOf(content: unknown, subs: unknown): string | undefined {
  const options: unknown[] = Array.isArray(content) ? content : [];
  const localised = options.find((item) => isRecord(item) && item.lang === 'en') ?? options[0];
  const text = stringOf(content) ?? (isRecord(localised) ? stringOf(localised.text) : undefined);
  if (text === undefined) return undefined;
  const substitutions = Array.isArray(subs) ? subs.map(String) : [];
  return text.replace(/\{(\d+)\}/g, (whole, index: string) => substitutions[Number(index)] ?? whole);
}

class FileReader {
  readonly entries: LootEntry[] = [];
  readonly groups: LootGroup[] = [];
  readonly problems: RuleFileProblem[] = [];
  private lineOf: (node: unknown) => number = () => 0;

  constructor(private readonly name: RuleFileName, private readonly source: RuleSource['file'] | undefined) {}

  private problem(line: number | undefined, text: string): void {
    this.problems.push(line === undefined ? { file: this.name, text } : { file: this.name, line, text });
  }

  read(text: string, substitution: Substitution | undefined): void {
    const lineCounter = new LineCounter();
    const document = parseDocument(text, { lineCounter, merge: true });
    this.lineOf = (node) => lineCounter.linePos((isNode(node) ? node.range?.[0] : undefined) ?? 0).line - 1;
    for (const error of document.errors) {
      const line = error.linePos?.[0].line;
      this.problem(line === undefined ? undefined : this.shifted(line - 1, substitution), error.message.split('\n')[0] ?? error.message);
    }
    if (document.errors.length > 0 || this.source === undefined) return;
    // One conversion of the whole document: converting each entry alone resolves its anchors again, and takes seconds on a masterlist.
    let converted: unknown;
    try {
      converted = document.toJS({ maxAliasCount: MAX_ALIASES });
    } catch (err) {
      return this.problem(undefined, err instanceof Error ? err.message : String(err));
    }
    this.eachItem(document, converted, 'groups', (item, plain) => this.group(item, plain));
    this.eachItem(document, converted, 'plugins', (item, plain) => this.entry(item, plain));
  }

  private eachItem(document: { get: (key: string, keepScalar: true) => unknown }, converted: unknown, key: string, read: (node: unknown, plain: unknown) => void): void {
    const list = document.get(key, true);
    const plain = isRecord(converted) && Array.isArray(converted[key]) ? converted[key] : [];
    if (isSeq(list)) list.items.forEach((item, index) => read(item, plain[index]));
  }

  private group(node: unknown, plain: unknown): void {
    const line = this.lineOf(node);
    if (!isRecord(plain)) return this.problem(line, 'A group is not a mapping.');
    const name = stringOf(plain.name);
    if (name === undefined) return this.problem(line, 'A group has no name.');
    const after = this.items(node, plain, 'after').flatMap(({ value, line: at }) => {
      const source = this.located(at);
      if (typeof value === 'string') return source === undefined ? [] : [{ name: value, source }];
      this.problem(at, 'An entry of "after" is not a name.');
      return [];
    });
    this.groups.push({ name, after });
  }

  // A line after the substituted prelude moves back to the line it has in the masterlist file.
  private shifted(line: number, substitution: Substitution | undefined): number | undefined {
    if (substitution === undefined || line < substitution.startLine) return line;
    if (line < substitution.startLine + substitution.newLines) return undefined;
    return line - substitution.newLines + substitution.oldLines;
  }

  private entry(node: unknown, plain: unknown): void {
    const line = this.lineOf(node);
    if (!isRecord(plain)) return;
    const name = stringOf(plain.name);
    if (name === undefined) return this.problem(line, 'A plugin entry has no name.');
    const matches = this.matcher(name, line);
    if (matches === undefined) return;
    const group = this.groupOfEntry(node, plain, line);
    this.entries.push({
      name, matches, exact: !REGEX_NAME.test(name), ...group === undefined ? {} : { group },
      req: this.files(node, plain, 'req'), inc: this.files(node, plain, 'inc'), after: this.files(node, plain, 'after'),
      msg: this.messages(node, plain),
    });
  }

  private groupOfEntry(node: unknown, plain: Record<string, unknown>, entryLine: number): LootEntry['group'] {
    if (plain.group === undefined) return undefined;
    const groupNode = isMap(node) ? node.get('group', true) : undefined;
    const line = groupNode === undefined ? entryLine : this.lineOf(groupNode);
    const name = stringOf(plain.group);
    if (name === undefined) {
      this.problem(line, 'A plugin\'s group is not a name.');
      return undefined;
    }
    const source = this.located(line);
    return source === undefined ? undefined : { name, source };
  }

  private matcher(name: string, line: number): ((filename: string) => boolean) | undefined {
    if (!REGEX_NAME.test(name)) {
      const folded = name.toLowerCase();
      return (filename) => filename.toLowerCase() === folded;
    }
    try {
      const pattern = new RegExp(`^(?:${name})$`, 'iu');
      return (filename) => pattern.test(filename);
    } catch (err) {
      this.problem(line, `"${name}" is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private located(line: number): RuleSource | undefined {
    return this.source === undefined ? undefined : { file: this.source, line };
  }

  // Each item of an entry's list, with the line it is on; an item that came through an alias is on the entry's.
  private items(entry: unknown, plain: Record<string, unknown>, key: string): { value: unknown; line: number }[] {
    const values = plain[key];
    if (!Array.isArray(values)) return [];
    const list = isMap(entry) ? entry.get(key, true) : undefined;
    return values.map((value: unknown, index) => ({ value, line: this.lineOf(isSeq(list) ? list.items[index] : entry) }));
  }

  private files(entry: unknown, plain: Record<string, unknown>, key: 'req' | 'inc' | 'after'): LootFile[] {
    return this.items(entry, plain, key).flatMap(({ value, line }): LootFile[] => {
      const source = this.located(line);
      if (source === undefined) return [];
      if (typeof value === 'string') return [{ name: value, source }];
      const name = isRecord(value) ? stringOf(value.name) : undefined;
      if (!isRecord(value) || name === undefined) {
        this.problem(line, `An entry of "${key}" has no name.`);
        return [];
      }
      const file: LootFile = { name, source };
      for (const field of ['display', 'detail'] as const) {
        const text = contentOf(value[field], undefined);
        if (text !== undefined) file[field] = text;
      }
      const condition = stringOf(value.condition) ?? stringOf(value.constraint);
      if (condition !== undefined) file.condition = condition;
      return [file];
    });
  }

  private messages(entry: unknown, plain: Record<string, unknown>): LootMessage[] {
    return this.items(entry, plain, 'msg').flatMap(({ value, line }): LootMessage[] => {
      const source = this.located(line);
      if (source === undefined || !isRecord(value)) return [];
      const level = MESSAGE_LEVELS[stringOf(value.type) ?? ''];
      const text = contentOf(value.content, value.subs);
      if (level === undefined) {
        this.problem(line, `A message has the type "${String(value.type)}", which is none of say, warn and error.`);
        return [];
      }
      if (text === undefined) {
        this.problem(line, 'A message has no content.');
        return [];
      }
      const message: LootMessage = { level, text, source };
      const condition = stringOf(value.condition);
      if (condition !== undefined) message.condition = condition;
      return [message];
    });
  }
}

function readRuleFile(name: RuleFileName, file: SortingRuleFile, source: RuleSource['file'] | undefined, substituted?: { text: string; substitution: Substitution }): FileReader {
  const reader = new FileReader(name, source);
  if (file.kind === 'unreadable') reader.problems.push({ file: name, text: file.reason });
  else if (file.kind === 'text') reader.read(substituted?.text ?? file.text, substituted?.substitution);
  return reader;
}

function readRules(files: SortingRuleFiles): { entries: LootEntry[]; groups: LootGroup[]; problems: RuleFileProblem[] } {
  const prelude = readRuleFile('prelude', files.prelude, undefined);
  const substituted = files.masterlist.kind === 'text' && files.prelude.kind === 'text'
    ? withPrelude(files.masterlist.text, files.prelude.text)
    : undefined;
  const masterlist = readRuleFile('masterlist', files.masterlist, 'masterlist', substituted);
  const userlist = readRuleFile('userlist', files.userlist, 'userlist');
  const allGroups = mergedByName([...masterlist.groups, ...userlist.groups]);
  const allEntries = [...masterlist.entries, ...userlist.entries];
  const declared = new Set([DEFAULT_GROUP, ...allGroups.map(({ name }) => name)]);
  const unsound: RuleFileProblem[] = [];
  const declaredGroups = allGroups.map(({ name, after }) => ({
    name,
    after: after.filter((step) => {
      if (declared.has(step.name)) return true;
      unsound.push({ file: step.source.file, line: step.source.line, text: `The group "${name}" loads after "${step.name}", which no file declares.` });
      return false;
    }),
  }));
  const afterOf = new Map(declaredGroups.map(({ name, after }) => [name, after]));
  const groups = withoutCycles(declaredGroups, afterOf);
  for (const { group } of allEntries) {
    if (group !== undefined && !declared.has(group.name)) {
      unsound.push({ file: group.source.file, line: group.source.line, text: `This plugin belongs to the group "${group.name}", which does not exist.` });
    }
  }
  unsound.push(...groupCycles(afterOf));
  return {
    entries: allEntries,
    groups,
    problems: [...prelude.problems, ...masterlist.problems, ...userlist.problems, ...unsound],
  };
}

// Each group once, its afters from the userlist first, so a rule points at the user's edge where both files state one.
function mergedByName(groups: readonly LootGroup[]): LootGroup[] {
  const afterOf = new Map<string, LootGroup['after']>();
  for (const { name, after } of groups) afterOf.set(name, [...afterOf.get(name) ?? [], ...after]);
  const userFirst = (after: LootGroup['after']): LootGroup['after'] =>
    [...after.filter(({ source }) => source.file === 'userlist'), ...after.filter(({ source }) => source.file !== 'userlist')];
  return [...afterOf].map(([name, after]) => ({ name, after: userFirst(after) }));
}

type AfterOf = ReadonlyMap<string, LootGroup['after']>;

function withoutCycles(groups: readonly LootGroup[], afterOf: AfterOf): LootGroup[] {
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (afterOf.get(from) ?? []).some((step) => reaches(step.name, target, seen));
  };
  return groups.map(({ name, after }) => ({ name, after: after.filter((step) => !reaches(step.name, name)) }));
}

function groupCycles(afterOf: AfterOf): RuleFileProblem[] {
  const problems: RuleFileProblem[] = [];
  const finished = new Set<string>();
  const walk = (name: string, path: readonly string[]): void => {
    for (const step of afterOf.get(name) ?? []) {
      const at = path.indexOf(step.name);
      if (at !== -1) {
        problems.push({ file: step.source.file, line: step.source.line, text: `The groups load after each other in a cycle: ${[...path.slice(at), step.name].join(' after ')}.` });
      } else if (!finished.has(step.name)) walk(step.name, [...path, step.name]);
    }
    finished.add(name);
  };
  for (const name of afterOf.keys()) if (!finished.has(name)) walk(name, [name]);
  return problems;
}

export interface ReadRules {
  files: SortingRuleFiles;
  entries: LootEntry[];
  groups: LootGroup[];
  problems: RuleFileProblem[];
}

const FILE_NAMES = ['masterlist', 'prelude', 'userlist'] as const;

const sameFile = (a: SortingRuleFile, b: SortingRuleFile): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `readRules` that answers the same object while the files hold what they held, so a change to anything else in
 *  the instance does not read the rules again, and the caller tells a change in them by identity. */
export function rulesReader(): (files: SortingRuleFiles) => ReadRules {
  let last: ReadRules | undefined;
  return (files) => {
    const previous = last;
    if (previous !== undefined && FILE_NAMES.every((name) => sameFile(previous.files[name], files[name]))) return previous;
    last = { files, ...readRules(files) };
    return last;
  };
}

/** A plugin and the plugins it loads after. */
export interface LoadAfter {
  readonly plugin: string;
  readonly after: readonly string[];
}

interface Insertion {
  readonly at: number;
  readonly text: string;
}

const sameName = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

const nameOf = (item: unknown): unknown => {
  const value = isScalar(item) ? item.value : item;
  return isMap(value) ? value.get('name') : value;
};

const scalar = (name: string, inFlow: boolean): string =>
  inFlow && /[[\]{},]/.test(name) ? JSON.stringify(name) : stringify(name).trimEnd();

const startOf = (node: unknown): number => (isNode(node) ? node.range?.[0] : undefined) ?? 0;
const endOf = (node: unknown): number => (isNode(node) ? node.range?.[1] : undefined) ?? 0;

/** Splices the userlist's text, so every byte an edit does not touch stays as written. */
class Userlist {
  private readonly insertions: Insertion[] = [];
  private readonly eol: string;

  constructor(private readonly text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
  }

  result(): string {
    let out = '';
    let from = 0;
    for (const { at, text } of [...this.insertions].sort((a, b) => a.at - b.at)) {
      out += this.text.slice(from, at) + text;
      from = at;
    }
    return out + this.text.slice(from);
  }

  get edited(): boolean { return this.insertions.length > 0; }

  private insert(at: number, text: string): void { this.insertions.push({ at, text }); }

  // After the last item, so a space before the closing bracket stays where it was.
  private insertInFlow(seq: YAMLSeq, text: string): void {
    const last = seq.items.at(-1);
    if (last === undefined) this.insert(endOf(seq) - 1, text);
    else this.insert(endOf(last), `, ${text}`);
  }

  private lines(indent: number, lines: readonly string[]): string {
    return lines.map((line) => this.eol + ' '.repeat(indent) + line).join('');
  }

  private columnOf(offset: number): number { return offset - (this.text.lastIndexOf('\n', offset - 1) + 1); }

  // The end of the line a node ends on, so a comment after it stays with it.
  private lineEndAfter(node: unknown): number {
    let end = endOf(node);
    while (end > 0 && this.text[end - 1] === '\n') end--;
    const newline = this.text.indexOf('\n', end);
    const lineEnd = newline < 0 ? this.text.length : newline;
    return lineEnd > 0 && this.text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
  }

  private dashColumn(seq: YAMLSeq): number {
    const first = startOf(seq.items[0]);
    return this.text.slice(first - this.columnOf(first), first).search(/-\s*$/);
  }

  appendPlugins(entries: readonly LoadAfter[]): void {
    const body = entries.flatMap(({ plugin, after }) => [`- name: ${scalar(plugin, false)}`, '  after:', ...after.map((name) => `    - ${scalar(name, false)}`)]);
    const lead = this.text === '' || this.text.endsWith('\n') ? '' : this.eol;
    this.insert(this.text.length, `${lead}plugins:${this.lines(2, body)}${this.eol}`);
  }

  addEntry(plugins: YAMLSeq, { plugin, after }: LoadAfter): void {
    if (plugins.flow === true) {
      const flow = `{name: ${scalar(plugin, true)}, after: [${after.map((name) => scalar(name, true)).join(', ')}]}`;
      this.insertInFlow(plugins, flow);
      return;
    }
    const first = plugins.items[0];
    const dash = first === undefined ? 2 : this.dashColumn(plugins);
    const lines = [`- name: ${scalar(plugin, false)}`, '  after:', ...after.map((name) => `    - ${scalar(name, false)}`)];
    this.insert(first === undefined ? endOf(plugins) : this.lineEndAfter(plugins.items.at(-1)), this.lines(dash, lines));
  }

  addAfters(entry: YAMLMap, held: unknown, names: readonly string[]): void {
    if (isSeq(held) && held.flow === true) {
      this.insertInFlow(held, names.map((name) => scalar(name, true)).join(', '));
    } else if (isSeq(held)) {
      const items = names.map((name) => `- ${scalar(name, false)}`);
      this.insert(this.lineEndAfter(held.items.at(-1)), this.lines(held.items.length > 0 ? this.dashColumn(held) : 0, items));
    } else if (held !== undefined) {
      throw new Error('The userlist has an "after" that is not a list.');
    } else if (entry.flow === true) {
      this.insert(endOf(entry) - 1, `, after: [${names.map((name) => scalar(name, true)).join(', ')}]`);
    } else {
      const key = startOf(entry.items[0]?.key);
      this.insert(this.lineEndAfter(entry), this.lines(this.columnOf(key), ['after:', ...names.map((name) => `  - ${scalar(name, false)}`)]));
    }
  }
}

function pluginsOf(doc: Document): YAMLSeq | undefined {
  if (doc.errors.length > 0) throw new Error(`The userlist does not parse: ${doc.errors[0]?.message}`);
  if (doc.contents === null) return undefined;
  if (!isMap(doc.contents)) throw new Error('The userlist is not a map.');
  const plugins = doc.contents.get('plugins', true);
  if (plugins === undefined) return undefined;
  if (!isSeq(plugins)) throw new Error('The userlist\'s "plugins" is not a list.');
  return plugins;
}

const distinct = (names: readonly string[]): string[] => names.filter((name, at) => names.findIndex((other) => sameName(other, name)) === at);

/** The userlist's text with each plugin loading after the plugins given, as LOOT writes it. The edit splices the entry it
 *  changes and nothing else, so a comment, an anchor or a spacing stays; the text itself when it holds every rule.
 *  Throws, for a text that is not a map of plugins. */
export function addLoadAfter(text: string | undefined, additions: readonly LoadAfter[]): string {
  const source = text ?? '';
  const plugins = pluginsOf(parseDocument(source));
  const userlist = new Userlist(source);
  const fresh: LoadAfter[] = [];
  for (const { plugin, after } of additions) {
    const entries = plugins?.items.filter((item): item is YAMLMap => isMap(item) && sameName(nameOf(item), plugin)) ?? [];
    const held = entries.flatMap((entry) => { const list = entry.get('after', true); return isSeq(list) ? list.items.map(nameOf) : []; });
    const missing = distinct(after.filter((name) => !held.some((have) => sameName(have, name))));
    if (missing.length === 0) continue;
    const entry = entries[0];
    if (entry !== undefined) userlist.addAfters(entry, entry.get('after', true), missing);
    else fresh.push({ plugin, after: missing });
  }
  if (plugins === undefined) { if (fresh.length > 0) userlist.appendPlugins(fresh); }
  else for (const addition of fresh) userlist.addEntry(plugins, addition);
  return userlist.edited ? userlist.result() : source;
}
