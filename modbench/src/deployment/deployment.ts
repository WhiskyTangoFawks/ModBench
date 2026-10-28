// Deployment (target-architecture.d2): a load order deployed into the deployment folder. Its one type
// is hardlink (deployment-hardlink.md): each file the game gets is linked to its copy in the instance.

import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { fold, foldedPathsBelow } from './foldedPaths';
import { pluginsTextOf, type PluginEntry } from '../loadOrderFileCodec/pluginsText';
import { ASIDE, changeAll, fileIdAt, recoveryIn, type Link, type Step } from './changes';
import { errorMessage } from '../ports/errorMessage';
import { pluginsTxtChange } from './pluginsTxt';
import type { PluginsTxtPlace } from './pluginsTxtPlace';
import { recordIn, type DeploymentRecord, type Written, type WrittenPluginsTxt } from './record';

/** A file the game gets: its path in the mod, `/`-separated, and the copy that wins it. */
export interface FileTheGameGets {
  readonly relativePath: string;
  readonly winner: string;
}

/** The plugin order the game reads, for the release of the game it is for. */
export interface PluginOrder {
  readonly release: string | undefined;
  readonly entries: readonly PluginEntry[];
}

// `renamed` names each file deploy found where the game reads plugins.txt and renamed, one a killed deploy renamed included.
type PluginsTxtDeployed =
  | { readonly kind: 'written' | 'unchanged'; readonly renamed: readonly string[] }
  | { readonly kind: 'notWritten'; readonly why: string };

interface Lost {
  readonly path: string;
  readonly winner: string;
}

/** `wrote` is false when the folder already held the load order. `leftOut` winners find a file deploy did not write at
 *  their path; `unmanaged` is every such file; `leftAside` is each file set aside and not removed. */
export interface Deployed {
  readonly wrote: boolean;
  readonly leftOut: readonly Lost[];
  readonly unmanaged: readonly string[];
  readonly lost: readonly Lost[];
  readonly leftAside: readonly string[];
  readonly pluginsTxt: PluginsTxtDeployed;
}

export interface Deployment {
  /** `files` in the order their winners win: of two that land at one path, the earlier wins it.
   *  When it cannot deploy, it throws why, and has written nothing or names what it left changed. */
  deploy(folder: string, files: Iterable<FileTheGameGets>, plugins: PluginOrder): Promise<Deployed>;
}

// A mod's Root folder holds what the game reads from beside its program; the rest is Data's.
function deployedPath(relativePath: string): string | undefined {
  const [first = '', ...below] = relativePath.split('/');
  if (first.startsWith('.')) return undefined;
  if (below.length === 0) return `Data/${relativePath}`;
  if (fold(first) === 'source') return undefined;
  return fold(first) === 'root' ? below.join('/') : `Data/${relativePath}`;
}

/** The path in Overwrite at which the next deploy links the file at `path` below the deployment folder back to it,
 *  or undefined when no mod file lands at that path. */
export function overwritePathOf(path: string): string | undefined {
  const [first = '', ...below] = path.split('/');
  if (path.split('/').some((segment) => ['', '.', '..'].includes(segment) || segment.includes('\\'))) return undefined;
  const inOverwrite = fold(first) === 'data' && below.length > 0 ? below.join('/') : `Root/${path}`;
  return deployedPath(inOverwrite) === undefined ? undefined : inOverwrite;
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
async function linksOnTheFolderVolume(folder: string, files: Iterable<FileTheGameGets>): Promise<{ wanted: Map<string, Link>; lost: Lost[] }> {
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
  const recovered = recoveryIn();
  const owned = new Map<string, Written>();
  for (const entry of written) {
    if (await recovered(join(folder, entry.path), entry) === entry.ino) owned.set(fold(entry.path), entry);
  }
  return owned;
}

interface Plan {
  readonly kept: readonly Written[];
  readonly links: readonly Link[];
  readonly relinks: readonly Link[];
  readonly removals: readonly Written[];
  readonly leftOut: readonly Lost[];
}

async function filesBelow(folder: string, within = ''): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(join(folder, within), { withFileTypes: true }).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return [];
    throw err;
  });
  for (const entry of entries) {
    const path = within === '' ? entry.name : `${within}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesBelow(folder, path));
    else found.push(path);
  }
  return found;
}

async function unmanagedIn(folder: string, managed: readonly Written[]): Promise<string[]> {
  const ours = new Set(managed.map(({ path }) => fold(path)));
  return (await filesBelow(folder)).filter((path) => !ours.has(fold(path)) && !path.includes(ASIDE));
}

async function planFor(folder: string, wanted: ReadonlyMap<string, Link>, owned: ReadonlyMap<string, Written>): Promise<Plan> {
  const inFolder = foldedPathsBelow(folder);
  const kept: Written[] = [];
  const links: Link[] = [];
  const relinks: Link[] = [];
  const leftOut: Lost[] = [];
  for (const [key, want] of wanted) {
    const own = owned.get(key);
    if (own?.ino === want.ino) kept.push(own);
    else if (own !== undefined) relinks.push({ ...want, path: own.path });
    else {
      const path = await inFolder(want.path);
      if (await fileIdAt(join(folder, path)) === undefined) links.push({ ...want, path });
      else leftOut.push({ path, winner: want.source });
    }
  }
  const removals = [...owned].filter(([key]) => !wanted.has(key)).map(([, own]) => own);
  return { kept, links, relinks, removals, leftOut };
}

const asWritten = ({ path, ino }: Written): Written => ({ path, ino });

interface PluginsPart {
  readonly steps: Step[];
  readonly recordChanged: boolean;
  recordAfter(): WrittenPluginsTxt | undefined;
  settle(): Promise<string[]>;
  deployed(): PluginsTxtDeployed;
}

async function pluginsPartOf(place: PluginsTxtPlace, folder: string, { release, entries }: PluginOrder, previous: WrittenPluginsTxt | undefined): Promise<PluginsPart> {
  const where = await place(release, folder);
  if ('why' in where) {
    return { steps: [], recordChanged: false, recordAfter: () => previous, settle: () => Promise.resolve([]), deployed: () => ({ kind: 'notWritten', why: where.why }) };
  }
  const change = await pluginsTxtChange(where.folder, pluginsTextOf(entries), previous);
  return {
    steps: change.step === undefined ? [] : [change.step],
    recordChanged: change.recordChanged,
    recordAfter: () => change.written(),
    settle: () => change.settle(),
    deployed: () => ({ kind: change.step === undefined ? 'unchanged' : 'written', renamed: change.renamed() }),
  };
}

async function deployTo(
  record: DeploymentRecord, place: PluginsTxtPlace, folder: string, files: Iterable<FileTheGameGets>, plugins: PluginOrder,
): Promise<Deployed> {
  const { wanted, lost } = await linksOnTheFolderVolume(folder, files);
  const recorded = await record.of(folder);
  const owned = await stillWritten(folder, recorded.files);
  const { kept, links, relinks, removals, leftOut } = await planFor(folder, wanted, owned);
  const after = [...kept, ...relinks, ...links].map(asWritten);
  const unmanaged = await unmanagedIn(folder, [...after, ...removals, ...relinks]);
  const part = await pluginsPartOf(place, folder, plugins, recorded.pluginsTxt);
  const recordWith = (files: readonly Written[]): Promise<void> => {
    const pluginsTxt = part.recordAfter();
    return record.write(folder, { files, ...(pluginsTxt === undefined ? {} : { pluginsTxt }) });
  };
  if (links.length + relinks.length + removals.length === 0 && !part.steps.length) {
    if (after.length !== recorded.files.length || part.recordChanged) await recordWith(after);
    return { wrote: false, leftOut, unmanaged, lost, leftAside: await part.settle(), pluginsTxt: part.deployed() };
  }
  // A hardlink's file ID is its source's, so the record is known before the files change. A deploy killed
  // part way leaves a record the next deploy recovers from (ADR-0003); a failed deploy restores the old one.
  const setAside = [...removals, ...relinks].map(asWritten);
  const intended = [...after, ...setAside];
  await record.write(folder, { files: intended, ...(recorded.pluginsTxt === undefined ? {} : { pluginsTxt: recorded.pluginsTxt }) });
  let leftAside: string[];
  try {
    leftAside = await changeAll(folder, { removals, relinks, links }, part.steps, () => recordWith(intended));
  } catch (err) {
    try {
      await record.write(folder, recorded);
    } catch (restoreErr) {
      throw new Error(`${errorMessage(err)}. Deploy could not restore its record: ${errorMessage(restoreErr)}`);
    }
    throw err;
  }
  leftAside.push(...await part.settle());
  return { wrote: true, leftOut, unmanaged, lost, leftAside, pluginsTxt: part.deployed() };
}

/** The hardlink deployment, one deploy at a time, which keeps what it wrote in `storage`, a folder of
 *  the instance's own that no deployment folder holds. */
export function hardlinkDeployment(storage: string, place: PluginsTxtPlace): Deployment {
  const record = recordIn(join(storage, 'deployment.json'));
  let last: Promise<unknown> = Promise.resolve();
  return {
    deploy(folder, files, plugins) {
      const run = last.then(() => deployTo(record, place, folder, files, plugins));
      last = run.catch(() => undefined);
      return run;
    },
  };
}
