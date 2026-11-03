import { relative, sep } from 'node:path';
import { git } from './git';

/** Commits the files of `folder` that the instance repository holds, and only them, as `message`. */
export async function commitFolder(instanceRoot: string, folder: string, message: string): Promise<void> {
  const pathspec = `:(literal)${relative(instanceRoot, folder).split(sep).join('/')}`;
  await git(instanceRoot, 'add', '-A', '--', pathspec);
  await git(instanceRoot, 'commit', '-q', '-m', message, '--', pathspec);
}
