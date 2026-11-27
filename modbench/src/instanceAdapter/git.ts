import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { nameWrites } from '../repositoriesLib/writesTold';
import { GIT_DIR } from './files';

const execFileAsync = promisify(execFile);

// A listing of every file a repository holds outgrows execFile's default buffer.
const OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 28 } as const;

type Git = (folder: string, ...args: string[]) => Promise<string>;
type GitFed = (folder: string, input: string | Buffer, ...args: string[]) => Promise<string>;

// Not status or diff: either may refresh .git/index.
const READS = new Set(['rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'grep', 'show', 'check-ignore', 'check-attr', 'rev-list', 'log', 'hash-object']);
const READING_ARGUMENTS = new Set(['--get', '--get-all', '--get-regexp', '--list', 'get-url']);

const isOption = (arg: string): boolean => /^-/.test(arg);

function subcommandAt(args: readonly string[]): number {
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!isOption(args[i] ?? '')) break;
  }
  return i;
}

function configFile(rest: readonly string[]): string | undefined {
  const at = rest.findIndex((arg) => arg === '-f' || arg === '--file');
  return at === -1 ? rest.find((arg) => arg.startsWith('--file='))?.slice('--file='.length) : rest[at + 1];
}

const operands = (rest: readonly string[]): number => rest.filter((arg) => !isOption(arg)).length;

// `index` is the repository's .git, or nothing for git staging into an index of its own.
type WritesOf = (rest: readonly string[], folder: string, gitDir: readonly string[], index: readonly string[]) => readonly string[];

// The repository's .git stands for git's own files: the instance keeps what it read of the repository under it.
const WRITES = new Map<string, WritesOf>([
  ['config', (rest, folder, gitDir) => {
    if (rest.some((arg) => READING_ARGUMENTS.has(arg))) return [];
    const file = configFile(rest);
    return file === undefined ? gitDir : [resolve(folder, file)];
  }],
  ['remote', (rest, _folder, gitDir) => (operands(rest) === 0 || rest.some((arg) => READING_ARGUMENTS.has(arg)) ? [] : gitDir)],
  ['symbolic-ref', (rest, _folder, gitDir) => (operands(rest) < 2 && !rest.some((arg) => arg === '-d' || arg === '--delete') ? [] : gitDir)],
  ['add', (_rest, _folder, _gitDir, index) => index],
  ['update-index', (_rest, _folder, _gitDir, index) => index],
  ['read-tree', (_rest, _folder, _gitDir, index) => index],
  ['reset', (_rest, _folder, gitDir) => gitDir],
  ['commit', (_rest, _folder, gitDir) => gitDir],
]);

// What a subcommand Modbench runs writes. A subcommand neither table holds is refused before it runs, so a new call
// names its writes here first.
function writtenBy(folder: string, args: readonly string[], ownIndex: boolean): readonly string[] {
  const at = subcommandAt(args);
  const subcommand = args[at] ?? '';
  if (READS.has(subcommand)) return [];
  const writes = WRITES.get(subcommand);
  if (writes === undefined) throw new Error(`git ${subcommand} is neither a read nor a write Modbench names`);
  const gitDir = [join(folder, GIT_DIR)];
  return writes(args.slice(at + 1), folder, gitDir, ownIndex ? [] : gitDir);
}

function gitWith(env: NodeJS.ProcessEnv | undefined, ownIndex: boolean): { git: Git; gitFed: GitFed } {
  const options = env === undefined ? OPTIONS : { ...OPTIONS, env };
  const naming = (folder: string, args: readonly string[]): void => {
    const written = writtenBy(folder, args, ownIndex);
    if (written.length > 0) nameWrites(written);
  };
  return {
    git: async (folder, ...args) => {
      naming(folder, args);
      return (await execFileAsync('git', ['-C', folder, ...args], options)).stdout;
    },
    gitFed: async (folder, input, ...args) => {
      naming(folder, args);
      const running = execFileAsync('git', ['-C', folder, ...args], options);
      // git that exits before it reads its input closes the pipe; its exit says why.
      running.child.stdin?.on('error', () => undefined);
      running.child.stdin?.end(input);
      return (await running).stdout;
    },
  };
}

/** What git answers in `folder`, and what it answers handed `input`. */
export const { git, gitFed } = gitWith(undefined, false);

/** git, staging into the index at `index` and not the repository's. */
export const gitStagingInto = (index: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_INDEX_FILE: index }, true);

/** git, each object it writes kept in `objects` and out of the repository. */
export const gitWritingInto = (objects: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_OBJECT_DIRECTORY: objects }, false);

/** What git answers in `folder`, byte for byte. */
export const gitBytes = async (folder: string, ...args: string[]): Promise<Buffer> =>
  (await execFileAsync('git', ['-C', folder, ...args], { ...OPTIONS, encoding: 'buffer' })).stdout;
