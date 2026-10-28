// Deployment (target-architecture.d2): a load order deployed into the deployment folder. Its one type
// is hardlink (deployment-hardlink.md): each file the game gets is linked to its copy in the instance.

import { link, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { fold, foldedPathsBelow } from './foldedPaths';
import { recordIn, type Written } from './record';

/** A file the game gets: its path in the mod, `/`-separated, and the copy that wins it. */
export interface FileTheGameGets {
  readonly relativePath: string;
  readonly winner: string;
}

/** A file the game gets that deploy left out, as an earlier one lands at its path below the folder. */
interface Lost {
  readonly path: string;
  readonly winner: string;
}

/** `wrote` is false when the deployment folder already held the load order. `leftOut` names each
 *  path below the folder whose file deploy did not write, so deploy left its winner out. */
export interface Deployed {
  readonly wrote: boolean;
  readonly leftOut: readonly string[];
  readonly lost: readonly Lost[];
}

export interface Deployment {
  /** `files` in the order their winners win: of two that land at one path, the earlier wins it.
   *  Throws, writing nothing, when it cannot deploy, and says why. */
  deploy(folder: string, files: Iterable<FileTheGameGets>): Promise<Deployed>;
}

interface Link extends Written {
  readonly source: string;
}

const isDotName = (name: string): boolean => name.startsWith('.');

// A mod's Root folder holds what the game reads from beside its program; the rest is Data's.
function deployedPath(relativePath: string): string | undefined {
  const names = relativePath.split('/');
  const [first, ...below] = names;
  if (names.some(isDotName)) return undefined;
  if (first === undefined || below.length === 0) return `Data/${relativePath}`;
  if (fold(first) === 'source') return undefined;
  return fold(first) === 'root' ? below.join('/') : `Data/${relativePath}`;
}

async function fileIdAt(path: string): Promise<string | undefined> {
  try {
    return String((await lstat(path, { bigint: true })).ino);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

async function volumeOf(path: string): Promise<string> {
  let volume = await realpath(path);
  const { dev } = await stat(volume, { bigint: true });
  for (let up = dirname(volume); up !== volume && (await stat(up, { bigint: true })).dev === dev; up = dirname(volume)) volume = up;
  return volume;
}

async function volumeIdOf(folder: string): Promise<bigint> {
  try {
    return (await stat(folder, { bigint: true })).dev;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') throw new Error(`The deployment folder ${folder} does not exist.`);
    throw err;
  }
}

// A hardlink cannot cross volumes.
async function wantedIn(folder: string, files: Iterable<FileTheGameGets>): Promise<{ wanted: Map<string, Link>; lost: Lost[] }> {
  const volume = await volumeIdOf(folder);
  const wanted = new Map<string, Link>();
  const lost: Lost[] = [];
  const elsewhere = new Map<bigint, string>();
  for (const { relativePath, winner } of files) {
    const path = deployedPath(relativePath);
    if (path === undefined) continue;
    const earlier = wanted.get(fold(path));
    if (earlier !== undefined) {
      lost.push({ path: earlier.path, winner });
      continue;
    }
    const { dev, ino } = await stat(winner, { bigint: true });
    if (dev !== volume) elsewhere.set(dev, winner);
    wanted.set(fold(path), { path, source: winner, ino: String(ino) });
  }
  if (elsewhere.size > 0) {
    const others = await Promise.all([...elsewhere.values()].map(volumeOf));
    throw new Error(`The deployment folder is on ${await volumeOf(folder)}, and the instance on ${others.join(', ')}: a hardlink cannot cross volumes.`);
  }
  return { wanted, lost };
}

async function stillWritten(folder: string, written: readonly Written[]): Promise<Map<string, Written>> {
  const owned = new Map<string, Written>();
  for (const entry of written) {
    if (await fileIdAt(join(folder, entry.path)) === entry.ino) owned.set(fold(entry.path), entry);
  }
  return owned;
}

interface Plan {
  readonly kept: readonly Written[];
  readonly links: readonly Link[];
  readonly relinks: readonly Link[];
  readonly removals: readonly Written[];
  readonly leftOut: readonly string[];
}

async function planFor(folder: string, wanted: ReadonlyMap<string, Link>, owned: ReadonlyMap<string, Written>): Promise<Plan> {
  const inFolder = foldedPathsBelow(folder);
  const kept: Written[] = [];
  const links: Link[] = [];
  const relinks: Link[] = [];
  const leftOut: string[] = [];
  for (const [key, want] of wanted) {
    const own = owned.get(key);
    if (own?.ino === want.ino) kept.push(own);
    else if (own !== undefined) relinks.push({ ...want, path: own.path });
    else {
      const path = await inFolder(want.path);
      if (await fileIdAt(join(folder, path)) === undefined) links.push({ ...want, path });
      else leftOut.push(path);
    }
  }
  const removals = [...owned].filter(([key]) => !wanted.has(key)).map(([, own]) => own);
  return { kept, links, relinks, removals, leftOut };
}

const asWritten = ({ path, ino }: Written): Written => ({ path, ino });

async function linkAt(folder: string, { path, source }: Link): Promise<void> {
  const at = join(folder, path);
  await mkdir(dirname(at), { recursive: true });
  await link(source, at);
}

async function deployTo(record: ReturnType<typeof recordIn>, folder: string, files: Iterable<FileTheGameGets>): Promise<Deployed> {
  const { wanted, lost } = await wantedIn(folder, files);
  const written = await record.of(folder);
  const owned = await stillWritten(folder, written);
  const { kept, links, relinks, removals, leftOut } = await planFor(folder, wanted, owned);
  const after = [...kept, ...relinks, ...links].map(asWritten);
  if (links.length + relinks.length + removals.length === 0) {
    if (after.length !== written.length) await record.write(folder, after);
    return { wrote: false, leftOut, lost };
  }
  // Written first, so a deploy cut short still owns every file it may have linked.
  await record.write(folder, [...owned.values(), ...relinks, ...links].map(asWritten));
  for (const { path } of [...removals, ...relinks]) await unlink(join(folder, path));
  for (const each of [...relinks, ...links]) await linkAt(folder, each);
  await record.write(folder, after);
  return { wrote: true, leftOut, lost };
}

/** The hardlink deployment, one deploy at a time, which keeps what it wrote in `storage`, a folder of
 *  the instance's own that no deployment folder holds. */
export function hardlinkDeployment(storage: string): Deployment {
  const record = recordIn(join(storage, 'deployment.json'));
  let last: Promise<unknown> = Promise.resolve();
  return {
    deploy(folder, files) {
      const run = last.then(() => deployTo(record, folder, files));
      last = run.catch(() => undefined);
      return run;
    },
  };
}
