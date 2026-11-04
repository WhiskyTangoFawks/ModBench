// instance-repository.md, The repository, story 3: a tool that hands git a file's text rather than its path stages it
// with no filter, and the diff's textconv shows it as filtered.

import { errorMessage } from '../ports/errorMessage';
import { git, gitBytes, gitFed } from './git';
import { keptByIndex } from './keptByIndex';

const blobsIn = (listing: string, entry: RegExp): Map<string, string> =>
  new Map(listing.split('\0').flatMap((line) => {
    const [, blob, path] = entry.exec(line) ?? [];
    return blob === undefined || path === undefined ? [] : [[path, blob]];
  }));

const STAGED = /^\d+ ([0-9a-f]+) 0\t(.*)$/s;
const COMMITTED = /^\d+ blob ([0-9a-f]+)\t(.*)$/s;

async function committedBlobs(repository: string): Promise<Map<string, string>> {
  const holdsHead = await git(repository, 'rev-parse', '-q', '--verify', 'HEAD').then(() => true, () => false);
  return holdsHead ? blobsIn(await git(repository, 'ls-tree', '-r', '-z', 'HEAD'), COMMITTED) : new Map();
}

// Line ends are git's own conversion, not the filter's, so a clone that converts them reads its file as committed.
const isUnfiltered = async (repository: string, path: string, blob: string): Promise<boolean> =>
  (await gitFed(repository, await gitBytes(repository, 'cat-file', 'blob', blob), '-c', 'core.autocrlf=false', 'hash-object', `--path=${path}`, '--stdin')).trim() !== blob;

function wording(index: boolean, head: boolean): string {
  const holders = index && head ? 'The index and HEAD hold' : index ? 'The index holds' : 'HEAD holds';
  const remedy = index ? `Stage the whole file to filter it${head ? ', then commit it' : ''}.` : 'Commit it as staged.';
  return `${holders} this file unfiltered, so a clone gets this machine's own values, such as its paths. ${remedy}`;
}

async function problemOf(repository: string, path: string, staged: string, committed: string | undefined): Promise<string | undefined> {
  try {
    const index = await isUnfiltered(repository, path, staged);
    const head = committed === undefined ? false : committed === staged ? index : await isUnfiltered(repository, path, committed);
    return index || head ? wording(index, head) : undefined;
  } catch (err) {
    return `could not be checked against its filter: ${errorMessage(err)}`;
  }
}

async function unfilteredIn(repository: string, drivers: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const staged = blobsIn(await git(repository, 'ls-files', '-s', '-z', '--', ...drivers.map((driver) => `:(attr:filter=${driver})`)), STAGED);
  if (staged.size === 0) return new Map();
  const committed = await committedBlobs(repository);
  const problems = await Promise.all([...staged].map(async ([path, blob]) => [path, await problemOf(repository, path, blob, committed.get(path))] as const));
  return new Map(problems.flatMap(([path, problem]) => (problem === undefined ? [] : [[path, problem]])));
}

/** Each file a filter of `drivers` covers that the index or HEAD holds as the filter would not make it, by its path, with
 *  its problem. A commit or checkout writes the index, so its stamp keeps the answer. */
export function unfilteredFiles(): (repository: string, drivers: readonly string[]) => Promise<ReadonlyMap<string, string>> {
  const kept = keptByIndex<ReadonlyMap<string, string>>();
  return (repository, drivers) => kept(repository, drivers.join('\0'), () => unfilteredIn(repository, drivers));
}
