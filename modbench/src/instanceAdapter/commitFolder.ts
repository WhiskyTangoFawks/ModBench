import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { git, gitFed, gitStagingInto } from './git';

const IGNORE_LIST = '.gitignore';

const literal = (path: string): string => `:(literal)${path}`;

const objectAt = async (instanceRoot: string, revision: string): Promise<string | undefined> =>
  git(instanceRoot, 'rev-parse', '-q', '--verify', revision).then((id) => id.trim(), () => undefined);

// With no ignore list committed, only the whole one leaves out what a clone must not hold.
async function ignoreListToCommit(instanceRoot: string, withLines: (ignoreList: string) => string): Promise<string | undefined> {
  if (!(await access(join(instanceRoot, IGNORE_LIST)).then(() => true, () => false))) return undefined;
  const committed = await objectAt(instanceRoot, `HEAD:${IGNORE_LIST}`);
  if (committed === undefined) return (await git(instanceRoot, 'hash-object', '-w', '--', IGNORE_LIST)).trim();
  const text = withLines(await git(instanceRoot, 'cat-file', 'blob', committed));
  return (await gitFed(instanceRoot, text, 'hash-object', '-w', '--stdin')).trim();
}

/** Commits the files of `folder` and the lines `withLines` adds to the committed ignore list, and nothing else, as
 *  `message`; with none committed, the ignore list whole. */
export async function commitFolder(instanceRoot: string, folder: string, message: string, withLines: (ignoreList: string) => string): Promise<void> {
  const inFolder = literal(relative(instanceRoot, folder).split(sep).join('/'));
  const blob = await ignoreListToCommit(instanceRoot, withLines);
  const head = await objectAt(instanceRoot, 'HEAD');
  const scratch = await mkdtemp(join(tmpdir(), 'modbench-commit-'));
  try {
    const staging = gitStagingInto(join(scratch, 'index'));
    await staging.git(instanceRoot, 'read-tree', head ?? '--empty');
    await staging.git(instanceRoot, 'add', '-A', '--', inFolder);
    if (blob !== undefined) await staging.git(instanceRoot, 'update-index', '--add', '--cacheinfo', `100644,${blob},${IGNORE_LIST}`);
    await staging.git(instanceRoot, 'commit', '-q', '-m', message);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await git(instanceRoot, 'reset', '-q', '--', inFolder, ...blob === undefined ? [] : [literal(IGNORE_LIST)]);
}
