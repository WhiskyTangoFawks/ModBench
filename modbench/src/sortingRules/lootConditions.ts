import { compareVersions, versionInDescription } from './lootVersion';

// `unknown` while the game's Data folder cannot be listed.
export type Presence = 'present' | 'absent' | 'unknown';

/** A read of one file's bytes or version resource, which the Instance adapter answers. `path` is relative to the
 *  Data folder, and may leave it with `../`. */
export interface FileRead {
  kind: 'checksum' | 'version' | 'productVersion' | 'readable';
  path: string;
}

/** What a read answered: the value, or why the file could not be read. A file that is not there is a value. */
export type FileAnswer<T> = { kind: 'read'; value: T } | { kind: 'unreadable'; why: string };

type ReadValue = string | number | boolean | undefined;

export interface ConditionFacts {
  /** The files the Data folder holds, relative to it with `/`; `complete` while its listing reads. */
  files: () => { names: readonly string[]; complete: boolean };
  isPresent: (path: string) => Presence;
  /** The filenames of the active plugins. */
  activePlugins: () => readonly string[];
  /** `undefined` while mEdit has not read the plugin. */
  isMaster: (plugin: string) => boolean | undefined;
  /** The plugin's description, `undefined` while mEdit has not read it. */
  description: (plugin: string) => string | undefined;
  /** The answer to a `FileRead`: a CRC-32, a version, or whether the file is readable; `undefined` for a file that
   *  does not exist or has no version. */
  answer: (read: FileRead) => FileAnswer<ReadValue>;
}

export type FileFacts = Pick<ConditionFacts, 'files' | 'isPresent' | 'answer'>;

/** What the Instance adapter reads of a file. Paths are relative to the Data folder, and may leave it with `../`. */
export interface FileReads {
  checksum: (path: string) => Promise<FileAnswer<number | undefined>>;
  version: (path: string, field: 'file' | 'product') => Promise<FileAnswer<string | undefined>>;
  readable: (path: string) => Promise<FileAnswer<boolean>>;
}

const readKey = ({ kind, path }: FileRead): string => `${kind}\0${path}`;

/** The reads without a repeat. */
export function distinctReads(reads: readonly FileRead[]): FileRead[] {
  return reads.filter((read, at) => reads.findIndex((other) => readKey(other) === readKey(read)) === at);
}

function performed({ kind, path }: FileRead, reads: FileReads): Promise<FileAnswer<ReadValue>> {
  switch (kind) {
    case 'checksum': return reads.checksum(path);
    case 'version': return reads.version(path, 'file');
    case 'productVersion': return reads.version(path, 'product');
    case 'readable': return reads.readable(path);
  }
}

/** The answers to `reads`, so that a condition is evaluated in one pass. A read that was not asked for is unreadable
 *  when a condition reaches it. */
export async function readFileFacts(
  reads: readonly FileRead[], source: FileReads, instance: Pick<ConditionFacts, 'files' | 'isPresent'>,
): Promise<FileFacts> {
  const answers = new Map(await Promise.all(reads.map(async (read): Promise<[string, FileAnswer<ReadValue>]> =>
    [readKey(read), await performed(read, source)])));
  return {
    ...instance,
    answer: (read) => answers.get(readKey(read)) ?? { kind: 'unreadable', why: `the ${read.kind} of "${read.path}" was not read` },
  };
}

type Unevaluable = { kind: 'unevaluable'; reason: string };

export type Evaluation = { kind: 'value'; value: boolean } | Unevaluable;

const yes = (value: boolean): Evaluation => ({ kind: 'value', value });
const cannot = (reason: string): Unevaluable => ({ kind: 'unevaluable', reason });

type Argument = { kind: 'string' | 'bare'; text: string };

type Node =
  | { kind: 'call'; name: string; args: Argument[] }
  | { kind: 'not'; operand: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node };

const TOKEN = /\s*(?:("[^"]*")|(\(|\)|,)|([^\s(),"]+))/y;

// Thrown and caught inside `parse` alone, to leave the recursive descent.
class NotParsed extends Error {}

function tokens(text: string): string[] {
  const found: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (match === null) {
      if (text.slice(TOKEN.lastIndex).trim() === '') break;
      throw new NotParsed('it does not parse');
    }
    found.push(match[0].trim());
  }
  return found;
}

function descend(text: string): Node {
  const list = tokens(text);
  let at = 0;
  const fail = (): never => { throw new NotParsed(`it does not parse: "${list[at] ?? 'end of condition'}" is unexpected`); };
  const peek = (): string | undefined => list[at];
  const take = (expected?: string): string => {
    const token = list[at];
    if (token === undefined || (expected !== undefined && token !== expected)) return fail();
    at++;
    return token;
  };
  const argument = (): Argument => {
    const token = take();
    if (token === '(' || token === ')' || token === ',') return fail();
    return token.startsWith('"') ? { kind: 'string', text: token.slice(1, -1) } : { kind: 'bare', text: token };
  };
  const call = (name: string): Node => {
    take('(');
    const args = [argument()];
    while (peek() === ',') {
      take(',');
      args.push(argument());
    }
    take(')');
    return { kind: 'call', name, args };
  };
  const operand = (): Node => {
    const token = take();
    if (token === 'not') return { kind: 'not', operand: operand() };
    if (token === '(') {
      const inner = expression();
      take(')');
      return inner;
    }
    return call(token);
  };
  const compound = (): Node => {
    let node = operand();
    while (peek() === 'and') {
      take();
      node = { kind: 'and', left: node, right: operand() };
    }
    return node;
  };
  const expression = (): Node => {
    let node = compound();
    while (peek() === 'or') {
      take();
      node = { kind: 'or', left: node, right: compound() };
    }
    return node;
  };
  const root = expression();
  if (at < list.length) fail();
  return root;
}

function parse(text: string): { kind: 'parsed'; node: Node } | Unevaluable {
  try {
    return { kind: 'parsed', node: descend(text) };
  } catch (err) {
    if (err instanceof NotParsed) return cannot(err.message);
    throw err;
  }
}

const fold = (text: string): string => text.toLowerCase();

const REGEX_PATH = /[:\\*?|]/;
const PLUGIN = /\.(esp|esm|esl)$/i;
const COMPARATORS = new Set(['==', '!=', '<', '>', '<=', '>=']);
const DATA_FOLDER_UNLISTED = "the game's Data folder cannot be listed";

function matching(candidates: readonly string[], path: string): { found: string[] } | { problem: string } {
  if (!REGEX_PATH.test(path)) return { found: candidates.filter((candidate) => fold(candidate) === fold(path)) };
  const slash = path.lastIndexOf('/');
  const directory = fold(path.slice(0, slash + 1));
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${path.slice(slash + 1)})$`, 'iu');
  } catch (err) {
    return { problem: `"${path}" is not a regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    found: candidates.filter((candidate) => {
      const end = candidate.lastIndexOf('/') + 1;
      return fold(candidate.slice(0, end)) === directory && pattern.test(candidate.slice(end));
    }),
  };
}

// At least `atLeast` of the files match; with fewer, the answer is no only while the whole folder is listed.
function filesMatching(path: string, atLeast: number, facts: ConditionFacts): Evaluation {
  const listing = facts.files();
  const matched = matching(listing.names, path);
  if ('problem' in matched) return cannot(matched.problem);
  if (matched.found.length >= atLeast) return yes(true);
  return listing.complete ? yes(false) : cannot(DATA_FOLDER_UNLISTED);
}

const leavesData = (path: string): boolean => path.startsWith('../');

function presence(path: string, facts: ConditionFacts): Evaluation {
  if (leavesData(path)) return withAnswer(facts, { kind: 'readable', path }, (readable) => readable === true);
  const found = facts.isPresent(path);
  return found === 'unknown' ? cannot(DATA_FOLDER_UNLISTED) : yes(found === 'present');
}

/** Whether the file is installed as `file()` says: a name with a regular expression in its filename needs only a match. */
export function isFilePresent(path: string, facts: ConditionFacts): Evaluation {
  return REGEX_PATH.test(path) ? filesMatching(path, 1, facts) : presence(path, facts);
}

/** Whether an incompatibility is present as LOOT counts it (validation.cpp, checkInstallValidity): a plugin only while it is active. */
export function isIncompatibilityPresent(path: string, facts: ConditionFacts): Evaluation {
  const present = isFilePresent(path, facts);
  if (present.kind === 'unevaluable' || !present.value) return present;
  const matched = REGEX_PATH.test(path) ? matching(facts.files().names, path) : { found: [path] };
  if ('problem' in matched) return cannot(matched.problem);
  const active = new Set(facts.activePlugins().map(fold));
  return yes(matched.found.some((file) => !PLUGIN.test(file) || active.has(fold(file))));
}

function withAnswer(facts: ConditionFacts, read: FileRead, use: (value: ReadValue) => boolean): Evaluation {
  const answer = facts.answer(read);
  return answer.kind === 'unreadable' ? cannot(answer.why) : yes(use(answer.value));
}

const activeMatching = (path: string, atLeast: number, facts: ConditionFacts): Evaluation => {
  const matched = matching(facts.activePlugins(), path);
  return 'problem' in matched ? cannot(matched.problem) : yes(matched.found.length >= atLeast);
};

type Quoted = { path: string } | Unevaluable;

function quoted(args: readonly Argument[], at: number, name: string): Quoted {
  const argument = args[at];
  return argument?.kind === 'string' ? { path: argument.text } : { kind: 'unevaluable', reason: `${name}() does not have a quoted argument ${at + 1}` };
}

function versionTest(name: string, args: readonly Argument[]): { path: string; test: (actual: string) => boolean } | Unevaluable {
  const comparator = args[1]?.text ?? '';
  const path = quoted(args, 0, name);
  const given = quoted(args, 2, name);
  if (args.length !== 3 || !COMPARATORS.has(comparator)) return { kind: 'unevaluable', reason: `${name}() is not of the form ${name}("path", comparator, "version")` };
  if ('kind' in path) return path;
  if ('kind' in given) return given;
  return {
    path: path.path,
    test: (actual) => {
      const order = compareVersions(actual, given.path);
      switch (comparator) {
        case '==': return order === 0;
        case '!=': return order !== 0;
        case '<': return order < 0;
        case '>': return order > 0;
        case '<=': return order <= 0;
        default: return order >= 0;
      }
    },
  };
}

const passes = (actual: ReadValue, test: (actual: string) => boolean): boolean => typeof actual === 'string' && test(actual);

function pluginVersion(path: string, test: (actual: string) => boolean, facts: ConditionFacts): Evaluation {
  const found = presence(path, facts);
  if (found.kind === 'unevaluable' || !found.value) return found;
  const description = facts.description(path);
  return description === undefined ? cannot(`mEdit has not read "${path}"`) : yes(passes(versionInDescription(description), test));
}

function callValue(name: string, args: readonly Argument[], facts: ConditionFacts): Evaluation {
  const first = quoted(args, 0, name);
  if ('kind' in first) return first;
  const { path } = first;
  switch (name) {
    case 'file': return isFilePresent(path, facts);
    case 'many': return filesMatching(path, 2, facts);
    case 'readable': return withAnswer(facts, { kind: 'readable', path }, (readable) => readable === true);
    case 'active': return activeMatching(path, 1, facts);
    case 'many_active': return activeMatching(path, 2, facts);
    case 'is_master': {
      const found = presence(path, facts);
      if (found.kind === 'unevaluable' || !found.value) return found;
      const master = facts.isMaster(path);
      return master === undefined ? cannot(`mEdit has not read "${path}"`) : yes(master);
    }
    case 'checksum': {
      const expected = args[1]?.text ?? '';
      if (args.length !== 2 || !/^[0-9a-f]{1,8}$/i.test(expected)) return cannot('checksum() is not of the form checksum("path", hexadecimal)');
      return withAnswer(facts, { kind: 'checksum', path }, (crc) => crc === parseInt(expected, 16));
    }
    case 'version':
    case 'product_version': {
      const compared = versionTest(name, args);
      if ('kind' in compared) return compared;
      if (name === 'product_version') return withAnswer(facts, { kind: 'productVersion', path }, (actual) => passes(actual, compared.test));
      if (PLUGIN.test(path)) return pluginVersion(path, compared.test, facts);
      return withAnswer(facts, { kind: 'version', path }, (actual) => passes(actual, compared.test));
    }
    default: return cannot(`${name}() is not a function Modbench evaluates`);
  }
}

function valueOf(node: Node, facts: ConditionFacts): Evaluation {
  switch (node.kind) {
    case 'call': return callValue(node.name, node.args, facts);
    case 'not': {
      const operand = valueOf(node.operand, facts);
      return operand.kind === 'value' ? yes(!operand.value) : operand;
    }
    case 'and':
    case 'or': {
      const left = valueOf(node.left, facts);
      if (left.kind === 'unevaluable' || left.value === (node.kind === 'or')) return left;
      return valueOf(node.right, facts);
    }
  }
}

/** A LOOT condition string held against the facts. A function Modbench does not evaluate, a read that failed and a
 *  condition that does not parse are `unevaluable`, never a value. */
export function evaluateCondition(condition: string, facts: ConditionFacts): Evaluation {
  const parsed = parse(condition);
  return parsed.kind === 'parsed' ? valueOf(parsed.node, facts) : parsed;
}

function readsIn(node: Node): FileRead[] {
  switch (node.kind) {
    case 'not': return readsIn(node.operand);
    case 'and':
    case 'or': return [...readsIn(node.left), ...readsIn(node.right)];
    case 'call': break;
  }
  const path = node.args[0]?.kind === 'string' ? node.args[0].text : undefined;
  if (path === undefined) return [];
  switch (node.name) {
    case 'file': return leavesData(path) && !REGEX_PATH.test(path) ? [{ kind: 'readable', path }] : [];
    case 'readable': return [{ kind: 'readable', path }];
    case 'checksum': return [{ kind: 'checksum', path }];
    case 'version': return PLUGIN.test(path) ? [] : [{ kind: 'version', path }];
    case 'product_version': return [{ kind: 'productVersion', path }];
    default: return [];
  }
}

/** The file reads `condition` needs, each once. None for a condition that does not parse. */
export function readsOf(condition: string): FileRead[] {
  const parsed = parse(condition);
  return parsed.kind === 'parsed' ? distinctReads(readsIn(parsed.node)) : [];
}
