import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { errnoCode } from '../ports/errno';
import { GIT_DIR, settledBefore, stampOf } from './files';
import type { FileStamp } from './instanceAdapter';

const textOrEmpty = (path: string): Promise<string> =>
  readFile(path, 'utf8').catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'EISDIR') return '';
    throw err;
  });

const valueAfter = (text: string, prefix: string): string | undefined =>
  text.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();

// A linked worktree's own git directory holds its HEAD and index; the refs, packed-refs, config and info/exclude are in the common one.
async function gitDirsOf(repository: string): Promise<{ readonly gitDir: string; readonly common: string }> {
  const dotGit = join(repository, GIT_DIR);
  const linked = valueAfter(await textOrEmpty(dotGit), 'gitdir:');
  const gitDir = linked === undefined ? dotGit : resolve(repository, linked);
  const commonDir = (await textOrEmpty(join(gitDir, 'commondir'))).trim();
  return { gitDir, common: commonDir === '' ? gitDir : resolve(gitDir, commonDir) };
}

async function stateFilesOf(repository: string): Promise<string[]> {
  const { gitDir, common } = await gitDirsOf(repository);
  const ref = valueAfter(await textOrEmpty(join(gitDir, 'HEAD')), 'ref:');
  const settings = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return [
    join(gitDir, 'HEAD'), join(gitDir, 'index'), join(common, 'packed-refs'), join(common, 'info', 'exclude'), join(common, 'config'),
    ...ref === undefined ? [] : [join(gitDir, ref), join(common, ref)],
    join(repository, '.gitignore'), join(repository, '.gitmodules'),
    join(homedir(), '.gitconfig'), join(settings, 'git', 'config'), join(settings, 'git', 'ignore'),
  ];
}

const stampsOf = (paths: readonly string[]): Promise<(FileStamp | undefined)[]> =>
  Promise.all(paths.map((path) => stampOf(path).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return undefined;
    throw err;
  })));

const signatureOf = (stamps: readonly (FileStamp | undefined)[]): string =>
  stamps.map((stamp) => (stamp === undefined ? 'absent' : `${stamp.size}:${stamp.modifiedNs}:${stamp.changedNs}`)).join(' ');

interface Kept<T> {
  readonly arguments: string;
  readonly signature: string;
  readonly value: T;
}

/** A keeper of answers git gives about a repository: each is read once under its `key` and `args`, and handed again while the
 *  stamps of the repository's state files are unchanged. */
export function keptByRepositoryState<T>(): (repository: string, key: string, read: () => Promise<T>, args?: readonly string[]) => Promise<T> {
  const kept = new Map<string, Kept<T>>();
  return async (repository, key, read, args = []) => {
    const where = `${repository}\0${key}`;
    const before = await stampsOf(await stateFilesOf(repository));
    const signature = signatureOf(before);
    const held = kept.get(where);
    if (held !== undefined && held.signature === signature && held.arguments === args.join('\0')) return held.value;
    const readFromMs = Date.now();
    const value = await read();
    if (before.every((stamp) => stamp === undefined || settledBefore(stamp, readFromMs))) kept.set(where, { arguments: args.join('\0'), signature, value });
    else kept.delete(where);
    return value;
  };
}
