import { compareVersions, versionInDescription } from './lootVersion';

// `unknown` while the game's Data folder cannot be listed.
type Presence = 'present' | 'absent' | 'unknown';

/** A read of one file's bytes or version resource, which the Instance adapter answers. `path` is relative to the
 *  Data folder, and may leave it with `../`. */
export interface FileRead {
  kind: 'checksum' | 'version' | 'productVersion' | 'readable';
  path: string;
}

/** A condition that cannot be given a value. */
export class Unevaluable extends Error {}

export interface ConditionFacts {
  /** Every file the Data folder holds, relative to it with `/`. */
  files: () => readonly string[];
  isPresent: (path: string) => Presence;
  /** The filenames of the active plugins. */
  activePlugins: () => readonly string[];
  /** `undefined` while mEdit has not read the plugin. */
  isMaster: (plugin: string) => boolean | undefined;
  /** The plugin's description, `undefined` while mEdit has not read it. */
  description: (plugin: string) => string | undefined;
  /** The answer to a `FileRead`: a CRC-32, a version, or whether the file is readable; `undefined` for a file that
   *  does not exist or has no version. Throws `Unevaluable` for a read that failed or was not made. */
  answer: (read: FileRead) => string | number | boolean | undefined;
}

export type FileFacts = Pick<ConditionFacts, 'files' | 'isPresent' | 'answer'>;

/** What the Instance adapter reads of a file. Paths are relative to the Data folder, and may leave it with `../`.
 *  A read rejects when the file cannot be read, and resolves `undefined` or `false` when there is no such file. */
export interface FileReads {
  checksum: (path: string) => Promise<number | undefined>;
  version: (path: string, field: 'file' | 'product') => Promise<string | undefined>;
  readable: (path: string) => Promise<boolean>;
}

const readKey = ({ kind, path }: FileRead): string => `${kind}\0${path}`;

function performed({ kind, path }: FileRead, reads: FileReads): Promise<string | number | boolean | undefined> {
  switch (kind) {
    case 'checksum': return reads.checksum(path);
    case 'version': return reads.version(path, 'file');
    case 'productVersion': return reads.version(path, 'product');
    case 'readable': return reads.readable(path);
  }
}

/** The answers to `reads`, so that a condition is evaluated in one pass. A read that failed, or was not asked for, is
 *  `Unevaluable` when a condition reaches it. */
export async function readFileFacts(
  reads: readonly FileRead[], source: FileReads, instance: Pick<ConditionFacts, 'files' | 'isPresent'>,
): Promise<FileFacts> {
  type Answer = { answered: string | number | boolean | undefined } | { failed: string };
  const answers = new Map(await Promise.all(reads.map(async (read): Promise<[string, Answer]> => {
    try {
      return [readKey(read), { answered: await performed(read, source) }];
    } catch (err) {
      return [readKey(read), { failed: err instanceof Error ? err.message : String(err) }];
    }
  })));
  return {
    ...instance,
    answer: (read) => {
      const answer = answers.get(readKey(read));
      if (answer === undefined) throw new Unevaluable(`the ${read.kind} of "${read.path}" was not read`);
      if ('failed' in answer) throw new Unevaluable(`the ${read.kind} of "${read.path}" could not be read: ${answer.failed}`);
      return answer.answered;
    },
  };
}

export type Evaluation = { kind: 'value'; value: boolean } | { kind: 'unevaluable'; reason: string };

type Argument = { kind: 'string' | 'bare'; text: string };

type Node =
  | { kind: 'call'; name: string; args: Argument[] }
  | { kind: 'not'; operand: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node };

const TOKEN = /\s*(?:("[^"]*")|(\(|\)|,)|([^\s(),"]+))/y;

function tokens(text: string): string[] {
  const found: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (match === null) {
      if (text.slice(TOKEN.lastIndex).trim() === '') break;
      throw new Unevaluable('it does not parse');
    }
    found.push(match[0].trim());
  }
  return found;
}

function parse(text: string): Node {
  const list = tokens(text);
  let at = 0;
  const fail = (): never => { throw new Unevaluable(`it does not parse: "${list[at] ?? 'end of condition'}" is unexpected`); };
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

const fold = (text: string): string => text.toLowerCase();

const REGEX_PATH = /[:\\*?|]/;
const PLUGIN = /\.(esp|esm|esl)$/i;
const COMPARATORS = new Set(['==', '!=', '<', '>', '<=', '>=']);

function matching(candidates: readonly string[], path: string): string[] {
  const slash = path.lastIndexOf('/');
  const directory = fold(path.slice(0, slash + 1));
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${path.slice(slash + 1)})$`, 'iu');
  } catch (err) {
    throw new Unevaluable(`"${path}" is not a regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return candidates.filter((candidate) => {
    const end = candidate.lastIndexOf('/') + 1;
    return fold(candidate.slice(0, end)) === directory && pattern.test(candidate.slice(end));
  });
}

const stringArgument = (args: readonly Argument[], at: number, name: string): string => {
  const argument = args[at];
  if (argument?.kind !== 'string') throw new Unevaluable(`${name}() does not have a quoted argument ${at + 1}`);
  return argument.text;
};

function versionTest(name: string, args: readonly Argument[]): { path: string; test: (actual: string) => boolean } {
  const comparator = args[1]?.text ?? '';
  if (args.length !== 3 || !COMPARATORS.has(comparator)) throw new Unevaluable(`${name}() is not of the form ${name}("path", comparator, "version")`);
  const path = stringArgument(args, 0, name);
  const given = stringArgument(args, 2, name);
  return {
    path,
    test: (actual) => {
      const order = compareVersions(actual, given);
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

function checksumTest(args: readonly Argument[]): { path: string; expected: number } {
  const expected = args[1]?.text ?? '';
  if (args.length !== 2 || !/^[0-9a-f]{1,8}$/i.test(expected)) throw new Unevaluable('checksum() is not of the form checksum("path", hexadecimal)');
  return { path: stringArgument(args, 0, 'checksum'), expected: parseInt(expected, 16) };
}

const leavesData = (path: string): boolean => path.startsWith('../');

function presentOrUnknown(path: string, facts: ConditionFacts): boolean {
  if (leavesData(path)) return facts.answer({ kind: 'readable', path }) === true;
  const presence = facts.isPresent(path);
  if (presence === 'unknown') throw new Unevaluable("the game's Data folder cannot be listed");
  return presence === 'present';
}

/** Whether the file is installed as `file()` says: a name with a regular expression in its filename needs only a match. */
export function isFilePresent(path: string, facts: ConditionFacts): boolean {
  if (REGEX_PATH.test(path)) return matching(facts.files(), path).length > 0;
  return presentOrUnknown(path, facts);
}

function callValue(name: string, args: readonly Argument[], facts: ConditionFacts): boolean {
  switch (name) {
    case 'file': return isFilePresent(stringArgument(args, 0, name), facts);
    case 'many': return matching(facts.files(), stringArgument(args, 0, name)).length > 1;
    case 'readable': return facts.answer({ kind: 'readable', path: stringArgument(args, 0, name) }) === true;
    case 'active': {
      const path = stringArgument(args, 0, name);
      if (REGEX_PATH.test(path)) return matching(facts.activePlugins(), path).length > 0;
      return facts.activePlugins().some((plugin) => fold(plugin) === fold(path));
    }
    case 'many_active': return matching(facts.activePlugins(), stringArgument(args, 0, name)).length > 1;
    case 'is_master': {
      const path = stringArgument(args, 0, name);
      if (!presentOrUnknown(path, facts)) return false;
      const master = facts.isMaster(path);
      if (master === undefined) throw new Unevaluable(`mEdit has not read "${path}"`);
      return master;
    }
    case 'checksum': {
      const { path, expected } = checksumTest(args);
      return facts.answer({ kind: 'checksum', path }) === expected;
    }
    case 'version': {
      const { path, test } = versionTest(name, args);
      if (!PLUGIN.test(path)) return pass(facts.answer({ kind: 'version', path }), test);
      if (!presentOrUnknown(path, facts)) return false;
      const description = facts.description(path);
      if (description === undefined) throw new Unevaluable(`mEdit has not read "${path}"`);
      return pass(versionInDescription(description), test);
    }
    case 'product_version': {
      const { path, test } = versionTest(name, args);
      return pass(facts.answer({ kind: 'productVersion', path }), test);
    }
    default: throw new Unevaluable(`${name}() is not a function Modbench evaluates`);
  }
}

const pass = (actual: string | number | boolean | undefined, test: (actual: string) => boolean): boolean =>
  typeof actual === 'string' && test(actual);

function valueOf(node: Node, facts: ConditionFacts): boolean {
  switch (node.kind) {
    case 'call': return callValue(node.name, node.args, facts);
    case 'not': return !valueOf(node.operand, facts);
    case 'and': return valueOf(node.left, facts) && valueOf(node.right, facts);
    case 'or': return valueOf(node.left, facts) || valueOf(node.right, facts);
  }
}

/** A LOOT condition string held against the facts. A function Modbench does not evaluate, a read that failed and a
 *  condition that does not parse are `unevaluable`, never a value. */
export function evaluateCondition(condition: string, facts: ConditionFacts): Evaluation {
  try {
    return { kind: 'value', value: valueOf(parse(condition), facts) };
  } catch (err) {
    if (err instanceof Unevaluable) return { kind: 'unevaluable', reason: err.message };
    throw err;
  }
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
  let reads: FileRead[];
  try {
    reads = readsIn(parse(condition));
  } catch (err) {
    if (err instanceof Unevaluable) return [];
    throw err;
  }
  return reads.filter((read, at) => reads.findIndex((other) => other.kind === read.kind && other.path === read.path) === at);
}
