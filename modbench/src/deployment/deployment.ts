// Deployment (target-architecture.d2): a load order deployed into the deployment folder. Its one type
// is hardlink (deployment-hardlink.md): each file the game gets is linked to its copy in the instance.

import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { fold, foldedPathsBelow } from './foldedPaths';
import { pluginsTextOf, type PluginEntry } from '../loadOrderFileCodec/pluginsText';
import { changeAll, fileIdAt, recoveryIn, type Link, type Step } from './changes';
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

/** `renamedTo` names the file deploy found where the game reads plugins.txt and renamed. */
export type PluginsTxtDeployed =
  | { readonly kind: 'written'; readonly renamedTo?: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'notWritten'; readonly why: string };

interface Lost {
  readonly path: string;
  readonly winner: string;
}

/** `wrote` is false when the folder already held the load order. Deploy leaves out the winner at each
 *  `leftOut` path and each `lost` winner, and `leftAside` names each file it set aside and could not remove. */
export interface Deployed {
  readonly wrote: boolean;
  readonly leftOut: readonly string[];
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

interface PluginsPart {
  readonly steps: Step[];
  /** Whether deploy has plugins.txt to write, or to record. */
  readonly changes: boolean;
  /** What the record holds of plugins.txt once the deploy lands. */
  recordAfter(): WrittenPluginsTxt | undefined;
  /** Removes what plugins.txt kept for the deploy to undo itself. */
  settle(): Promise<string[]>;
  deployed(): PluginsTxtDeployed;
}

async function pluginsPartOf(place: PluginsTxtPlace, { release, entries }: PluginOrder, previous: WrittenPluginsTxt | undefined): Promise<PluginsPart> {
  const where = place(release);
  if ('why' in where) {
    return { steps: [], changes: false, recordAfter: () => previous, settle: () => Promise.resolve([]), deployed: () => ({ kind: 'notWritten', why: where.why }) };
  }
  const change = await pluginsTxtChange(where.folder, pluginsTextOf(entries), previous);
  if (change.kind === 'unchanged') {
    return { steps: [], changes: change.adopted !== undefined, recordAfter: () => change.adopted ?? previous, settle: () => change.settle(), deployed: () => ({ kind: 'unchanged' }) };
  }
  const renamedTo = (): PluginsTxtDeployed => ({ kind: 'written', ...(change.renamedTo() === undefined ? {} : { renamedTo: change.renamedTo() }) });
  return { steps: [change.step], changes: true, recordAfter: change.written, settle: () => change.settle(), deployed: renamedTo };
}

async function deployTo(
  record: DeploymentRecord, place: PluginsTxtPlace, folder: string, files: Iterable<FileTheGameGets>, plugins: PluginOrder,
): Promise<Deployed> {
  const { wanted, lost } = await linksOnTheFolderVolume(folder, files);
  const recorded = await record.of(folder);
  const owned = await stillWritten(folder, recorded.files);
  const { kept, links, relinks, removals, leftOut } = await planFor(folder, wanted, owned);
  const after = [...kept, ...relinks, ...links].map(asWritten);
  const part = await pluginsPartOf(place, plugins, recorded.pluginsTxt);
  const recordWith = (files: readonly Written[]): Promise<void> => {
    const pluginsTxt = part.recordAfter();
    return record.write(folder, { files, ...(pluginsTxt === undefined ? {} : { pluginsTxt }) });
  };
  if (links.length + relinks.length + removals.length === 0 && !part.steps.length) {
    if (after.length !== recorded.files.length || part.changes) await recordWith(after);
    return { wrote: false, leftOut, lost, leftAside: await part.settle(), pluginsTxt: part.deployed() };
  }
  // The record keeps each file set aside, so the next deploy removes one this deploy could not.
  const setAside = [...removals, ...relinks].map(asWritten);
  const leftAside = await changeAll(folder, { removals, relinks, links }, part.steps, () => recordWith([...after, ...setAside]));
  leftAside.push(...await part.settle());
  return { wrote: true, leftOut, lost, leftAside, pluginsTxt: part.deployed() };
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
