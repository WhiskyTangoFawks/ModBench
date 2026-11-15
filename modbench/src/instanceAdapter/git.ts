import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { leaveWritesUnnamed } from '../repositoriesLib/writesTold';

const execFileAsync = promisify(execFile);

// A listing of every file a repository holds outgrows execFile's default buffer.
const OPTIONS = { encoding: 'utf8', maxBuffer: 1 << 28 } as const;

type Git = (folder: string, ...args: string[]) => Promise<string>;
type GitFed = (folder: string, input: string | Buffer, ...args: string[]) => Promise<string>;

const READS = new Set(['status', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'for-each-ref', 'grep', 'show', 'check-ignore', 'check-attr', 'rev-list', 'log', 'diff', 'hash-object']);
const READING_ARGUMENTS = new Set(['--get', '--get-all', '--get-regexp', '--list', 'get-url']);

function subcommandOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!/^-/.test(args[i] ?? '')) return args[i];
  }
  return undefined;
}

// A subcommand not known to only read may write any file of the working tree.
function leaveWritesUnnamedUnlessReading(args: readonly string[]): void {
  const subcommand = subcommandOf(args);
  const reads = subcommand !== undefined && (READS.has(subcommand) || (['config', 'remote'].includes(subcommand) && args.some((arg) => READING_ARGUMENTS.has(arg))));
  if (!reads) leaveWritesUnnamed();
}

function gitWith(env: NodeJS.ProcessEnv | undefined, writesTheWorkingTree: boolean): { git: Git; gitFed: GitFed } {
  const options = env === undefined ? OPTIONS : { ...OPTIONS, env };
  const leaving = (args: readonly string[]): void => { if (writesTheWorkingTree) leaveWritesUnnamedUnlessReading(args); };
  return {
    git: async (folder, ...args) => {
      leaving(args);
      return (await execFileAsync('git', ['-C', folder, ...args], options)).stdout;
    },
    gitFed: async (folder, input, ...args) => {
      leaving(args);
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
