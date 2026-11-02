import { isMap, isNode, isSeq, LineCounter, parseDocument } from 'yaml';

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
  group?: string;
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
    const plugins = document.get('plugins', true);
    const groups = document.get('groups', true);
    if (!isSeq(plugins) && !isSeq(groups)) return;
    // One conversion of the whole document: converting each entry alone resolves its anchors again, and takes seconds on a masterlist.
    let converted: unknown;
    try {
      converted = document.toJS({ maxAliasCount: MAX_ALIASES });
    } catch (err) {
      return this.problem(undefined, err instanceof Error ? err.message : String(err));
    }
    const plainOf = (key: string): unknown[] => (isRecord(converted) && Array.isArray(converted[key]) ? converted[key] : []);
    const plainPlugins = plainOf('plugins');
    const plainGroups = plainOf('groups');
    if (isSeq(groups)) groups.items.forEach((item, index) => this.group(item, plainGroups[index]));
    if (isSeq(plugins)) plugins.items.forEach((item, index) => this.entry(item, plainPlugins[index]));
  }

  private group(node: unknown, plain: unknown): void {
    const line = this.lineOf(node);
    if (!isRecord(plain)) return;
    const name = stringOf(plain.name);
    if (name === undefined) return this.problem(line, 'A group has no name.');
    const after = this.items(node, plain, 'after').flatMap(({ value, line: at }) => {
      const source = this.located(at);
      return typeof value === 'string' && source !== undefined ? [{ name: value, source }] : [];
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
    const group = stringOf(plain.group);
    this.entries.push({
      name, matches, ...group === undefined ? {} : { group },
      req: this.files(node, plain, 'req'), inc: this.files(node, plain, 'inc'), after: this.files(node, plain, 'after'),
      msg: this.messages(node, plain),
    });
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
  return {
    entries: [...masterlist.entries, ...userlist.entries],
    groups: [...masterlist.groups, ...userlist.groups],
    problems: [...prelude.problems, ...masterlist.problems, ...userlist.problems],
  };
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
