import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { leaveWritesUnnamed, nameWrites } from '../repositoriesLib/writesTold';
import { GIT_DIR } from './files';

const execFileAsync = promisify(execFile);

// A listing of every file a repository holds outgrows execFile's default buffer.
const OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 28 } as const;

type Git = (folder: string, ...args: string[]) => Promise<string>;
type GitFed = (folder: string, input: string | Buffer, ...args: string[]) => Promise<string>;

const READS = new Set(['status', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'grep', 'show', 'check-ignore', 'check-attr', 'rev-list', 'log', 'diff', 'hash-object']);
const READING_ARGUMENTS = new Set(['--get', '--get-all', '--get-regexp', '--list', 'get-url']);
const WORKING_TREE_RESETS = new Set(['--hard', '--merge', '--keep']);

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

type Written = (rest: readonly string[], folder: string, gitDir: readonly string[]) => readonly string[] | undefined;

// The repository's .git stands for git's own files: the instance keeps what it read of the repository under it.
const WRITES = new Map<string, Written>([
  ['config', (rest, folder, gitDir) => {
    if (rest.some((arg) => READING_ARGUMENTS.has(arg))) return [];
    const file = configFile(rest);
    return file === undefined ? gitDir : [resolve(folder, file)];
  }],
  ['remote', (rest, _folder, gitDir) => (operands(rest) === 0 || rest.includes('get-url') ? [] : gitDir)],
  ['symbolic-ref', (rest, _folder, gitDir) => (operands(rest) < 2 && !rest.some((arg) => arg === '-d' || arg === '--delete') ? [] : gitDir)],
  ['update-index', (_rest, _folder, gitDir) => gitDir],
  ['reset', (rest, _folder, gitDir) => (rest.some((arg) => WORKING_TREE_RESETS.has(arg)) ? undefined : gitDir)],
]);

// What a subcommand writes; undefined for one that may write any file of the working tree.
function writtenBy(folder: string, args: readonly string[]): readonly string[] | undefined {
  const at = subcommandAt(args);
  const subcommand = args[at] ?? '';
  if (READS.has(subcommand)) return [];
  return WRITES.get(subcommand)?.(args.slice(at + 1), folder, [join(folder, GIT_DIR)]);
}

function gitWith(env: NodeJS.ProcessEnv | undefined, writesTheWorkingTree: boolean): { git: Git; gitFed: GitFed } {
  const options = env === undefined ? OPTIONS : { ...OPTIONS, env };
  const naming = (folder: string, args: readonly string[]): void => {
    if (!writesTheWorkingTree) return;
    const written = writtenBy(folder, args);
    if (written === undefined) leaveWritesUnnamed();
    else if (written.length > 0) nameWrites(written);
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
export const { git, gitFed } = gitWith(undefined, true);

/** git, staging into the index at `index` and not the repository's. */
export const gitStagingInto = (index: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_INDEX_FILE: index }, false);

/** git, each object it writes kept in `objects` and out of the repository. */
export const gitWritingInto = (objects: string): { git: Git; gitFed: GitFed } => gitWith({ ...process.env, GIT_OBJECT_DIRECTORY: objects }, false);

/** What git answers in `folder`, byte for byte. */
export const gitBytes = async (folder: string, ...args: string[]): Promise<Buffer> =>
  (await execFileAsync('git', ['-C', folder, ...args], { ...OPTIONS, encoding: 'buffer' })).stdout;
