// Deployment (target-architecture.d2): a load order deployed into the deployment folder. Its one type
// is hardlink (deployment-hardlink.md): each file the game gets is linked to its copy in the instance.

import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { fold, foldedPathsBelow } from './foldedPaths';
import { PLUGINS_FILE_NAME, pluginsTextOf, type PluginEntry } from '../loadOrderFileCodec/pluginsText';
import { ASIDE, changeAll, fileIdAt, fileIdOf, recoveryIn, removedIfEmpty, type Link, type Step } from './changes';
import { errorMessage } from '../ports/errorMessage';
import { pluginsTxtChange, pluginsTxtPurge } from './pluginsTxt';
import type { PluginsTxtPlace } from './pluginsTxtPlace';
import { recordIn, type DeploymentRecord, type Recorded, type Written, type WrittenPluginsTxt } from './record';

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
  /** Why the record still names files that are gone. */
  readonly staleRecord?: string;
  readonly pluginsTxt: PluginsTxtDeployed;
}

/** `unmanaged` is every file left in the folder that is not as deploy wrote it; `unfinished` names, with why, what a landed purge did not finish. */
export interface Purged {
  readonly wrote: boolean;
  readonly restored: string | undefined;
  readonly leftRenamed: readonly string[];
  readonly unmanaged: readonly string[];
  readonly unfinished: readonly string[];
}

export interface Deployment {
  /** `files` in the order their winners win: of two that land at one path, the earlier wins it.
   *  When it cannot deploy, it throws why, and has written nothing or names what it left changed. */
  deploy(folder: string, files: Iterable<FileTheGameGets>, plugins: PluginOrder): Promise<Deployed>;
  /** Removes each file deploy wrote to `folder` that is still as deploy wrote it, and puts back the plugins.txt deploy renamed.
   *  When it cannot, it throws why, and has written nothing or names what it left changed. */
  purge(folder: string): Promise<Purged>;
  /** Every file in `folder` that is not still as deploy last wrote it. */
  unmanaged(folder: string): Promise<string[]>;
}

// A mod's Root folder holds what the game reads from beside its program; the rest is Data's.
export function deployedPath(relativePath: string): string | undefined {
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
  const inOverwrite = fold(first) === 'data' && below.length > 0 ? below.join('/') : `Root/${path}`;
  const back = deployedPath(inOverwrite);
  return back !== undefined && fold(back) === fold(path) ? inOverwrite : undefined;
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
    const stats = await stat(winner, { bigint: true });
    if (stats.dev !== volume) elsewhere.set(stats.dev, winner);
    wanted.set(fold(path), { path, source: winner, fileId: fileIdOf(stats) });
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
    if (await recovered(join(folder, entry.path), entry) === entry.fileId) owned.set(fold(entry.path), entry);
  }
  return owned;
}

interface Plan {
  readonly kept: readonly Written[];
  readonly links: readonly Link[];
  readonly relinks: readonly Link[];
  readonly replaced: readonly Written[];
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

// A file is deploy's when it is at a recorded path, by case alone, and is the file recorded there.
async function unmanagedIn(folder: string, managed: readonly Written[]): Promise<string[]> {
  const recordedAt = new Map<string, string[]>();
  for (const { path, fileId } of managed) recordedAt.set(fold(path), [...recordedAt.get(fold(path)) ?? [], fileId]);
  const unmanaged: string[] = [];
  for (const path of await filesBelow(folder)) {
    const recorded = recordedAt.get(fold(path));
    const isOurs = recorded !== undefined && recorded.includes(await fileIdAt(join(folder, path)) ?? '');
    if (!isOurs && !path.includes(ASIDE)) unmanaged.push(path);
  }
  return unmanaged;
}

async function planFor(folder: string, wanted: ReadonlyMap<string, Link>, owned: ReadonlyMap<string, Written>): Promise<Plan> {
  const inFolder = foldedPathsBelow(folder);
  const kept: Written[] = [];
  const links: Link[] = [];
  const relinks: Link[] = [];
  const replaced: Written[] = [];
  const leftOut: Lost[] = [];
  for (const [key, want] of wanted) {
    const own = owned.get(key);
    if (own?.fileId === want.fileId) kept.push(own);
    else if (own !== undefined) {
      relinks.push({ ...want, path: own.path });
      replaced.push(own);
    }
    else {
      const path = await inFolder(want.path);
      if (await fileIdAt(join(folder, path)) === undefined) links.push({ ...want, path });
      else leftOut.push({ path, winner: want.source });
    }
  }
  const removals = [...owned].filter(([key]) => !wanted.has(key)).map(([, own]) => own);
  return { kept, links, relinks, replaced, removals, leftOut };
}

const asWritten = ({ path, fileId }: Written): Written => ({ path, fileId });

interface PluginsPart {
  readonly steps: Step[];
  readonly recordChanged: boolean;
  /** What the record holds of plugins.txt while the deploy changes it, so a deploy killed there is recovered. */
  recordBefore(): WrittenPluginsTxt | undefined;
  recordAfter(): WrittenPluginsTxt | undefined;
  settle(): Promise<string[]>;
  deployed(): PluginsTxtDeployed;
}

async function pluginsPartOf(place: PluginsTxtPlace, folder: string, { release, entries }: PluginOrder, previous: WrittenPluginsTxt | undefined): Promise<PluginsPart> {
  const where = await place(release, folder);
  if ('why' in where) {
    return { steps: [], recordChanged: false, recordBefore: () => previous, recordAfter: () => previous, settle: () => Promise.resolve([]), deployed: () => ({ kind: 'notWritten', why: where.why }) };
  }
  const path = join(where.folder, PLUGINS_FILE_NAME);
  const change = await pluginsTxtChange(where.folder, pluginsTextOf(entries), previous);
  return {
    steps: change.step === undefined ? [] : [change.step],
    recordChanged: change.recordChanged,
    recordBefore: () => (previous?.path === path ? previous : { path, fileId: '', renamed: [] }),
    recordAfter: () => change.written(),
    settle: () => change.settle(),
    deployed: () => ({ kind: change.step === undefined ? 'unchanged' : 'written', renamed: change.renamed() }),
  };
}

// A folder deploy makes is one a link at one of `paths` needs and the folder does not hold.
async function foldersToMake(folder: string, paths: readonly string[]): Promise<string[]> {
  const missing = new Set<string>();
  for (const path of paths) {
    for (let dir = dirname(path); dir !== '.' && !missing.has(dir); dir = dirname(dir)) {
      if (await fileIdAt(join(folder, dir)) !== undefined) break;
      missing.add(dir);
    }
  }
  return [...missing];
}

async function restoredRecord(record: DeploymentRecord, folder: string, recorded: Recorded, err: unknown, gesture: 'Deploy' | 'Purge'): Promise<Error> {
  try {
    await record.write(folder, recorded);
  } catch (restoreErr) {
    return new Error(`${errorMessage(err)}. ${gesture} could not restore its record: ${errorMessage(restoreErr)}`);
  }
  return err instanceof Error ? err : new Error(errorMessage(err));
}

async function deployTo(
  record: DeploymentRecord, place: PluginsTxtPlace, folder: string, files: Iterable<FileTheGameGets>, plugins: PluginOrder,
): Promise<Deployed> {
  const { wanted, lost } = await linksOnTheFolderVolume(folder, files);
  const recorded = await record.of(folder);
  const owned = await stillWritten(folder, recorded.files);
  const { kept, links, relinks, replaced, removals, leftOut } = await planFor(folder, wanted, owned);
  const after = [...kept, ...relinks, ...links].map(asWritten);
  const setAside = [...removals, ...replaced].map(asWritten);
  const unmanaged = await unmanagedIn(folder, [...after, ...setAside]);
  const part = await pluginsPartOf(place, folder, plugins, recorded.pluginsTxt);
  const folders = [...new Set([...recorded.folders, ...await foldersToMake(folder, [...relinks, ...links].map(({ path }) => path))])];
  const recordWith = (files: readonly Written[]): Promise<void> => {
    const pluginsTxt = part.recordAfter();
    return record.write(folder, { files, folders, ...(pluginsTxt === undefined ? {} : { pluginsTxt }) });
  };
  if (links.length + relinks.length + removals.length === 0 && !part.steps.length) {
    if (after.length !== recorded.files.length || part.recordChanged) await recordWith(after);
    return { wrote: false, leftOut, unmanaged, lost, leftAside: await part.settle(), pluginsTxt: part.deployed() };
  }
  // A hardlink's file ID is its source's, so the record is known before the files change. A deploy killed
  // part way leaves a record the next deploy recovers from (ADR-0003); a failed deploy restores the old one.
  const intended = [...after, ...setAside];
  const before = part.recordBefore();
  await record.write(folder, { files: intended, folders, ...(before === undefined ? {} : { pluginsTxt: before }) });
  let leftAside: string[];
  try {
    leftAside = await changeAll(folder, { removals, relinks, links }, part.steps, () => recordWith(intended), 'Deploy');
  } catch (err) {
    throw await restoredRecord(record, folder, recorded, err, 'Deploy');
  }
  let staleRecord: string | undefined;
  if (leftAside.length === 0) {
    try {
      await recordWith(after);
    } catch (err) {
      staleRecord = errorMessage(err);
    }
  }
  leftAside.push(...await part.settle());
  return { wrote: true, leftOut, unmanaged, lost, leftAside, staleRecord, pluginsTxt: part.deployed() };
}

async function removedFolders(folder: string, made: readonly string[], unfinished: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const dir of [...made].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try {
      if (!await removedIfEmpty(join(folder, dir))) kept.push(dir);
    } catch (err) {
      kept.push(dir);
      unfinished.push(`${dir}, a folder deploy made (${errorMessage(err)})`);
    }
  }
  return kept;
}

async function unmanagedLeft(folder: string, unfinished: string[]): Promise<string[]> {
  try {
    return await unmanagedIn(folder, []);
  } catch (err) {
    unfinished.push(`the files left in the folder, which it could not read (${errorMessage(err)})`);
    return [];
  }
}

async function purgeFrom(record: DeploymentRecord, folder: string): Promise<Purged> {
  const recorded = await record.of(folder);
  const removals = [...(await stillWritten(folder, recorded.files)).values()];
  const plugins = recorded.pluginsTxt === undefined ? undefined : await pluginsTxtPurge(recorded.pluginsTxt);
  const steps = plugins?.step === undefined ? [] : [plugins.step];
  const unfinished: string[] = [];
  const wrote = removals.length + steps.length > 0;
  if (wrote) {
    // Blanking the file ID leaves a purge killed after it put the user's file back no claim on that file: it is known by its mark alone.
    const pluginsTxt = recorded.pluginsTxt === undefined ? {} : { pluginsTxt: { ...recorded.pluginsTxt, fileId: '' } };
    await record.write(folder, { files: recorded.files, folders: recorded.folders, ...pluginsTxt });
    try {
      unfinished.push(...await changeAll(folder, { removals, relinks: [], links: [] }, steps, () => Promise.resolve(), 'Purge'));
    } catch (err) {
      throw await restoredRecord(record, folder, recorded, err, 'Purge');
    }
  }
  unfinished.push(...await plugins?.settle() ?? []);
  const folders = await removedFolders(folder, recorded.folders, unfinished);
  if (recorded.files.length > 0 || recorded.pluginsTxt !== undefined || folders.length !== recorded.folders.length) {
    try {
      await record.write(folder, { files: [], folders });
    } catch (err) {
      unfinished.push(`the record of what deploy wrote (${errorMessage(err)})`);
    }
  }
  const hadRecord = recorded.files.length > 0 || recorded.pluginsTxt !== undefined;
  const unmanaged = hadRecord ? await unmanagedLeft(folder, unfinished) : [];
  return {
    wrote, restored: plugins?.restored, leftRenamed: plugins?.left ?? [], unfinished,
    unmanaged,
  };
}

/** The hardlink deployment, one deploy at a time, which keeps what it wrote in `storage`, a folder of
 *  the instance's own that no deployment folder holds. */
export function hardlinkDeployment(storage: string, place: PluginsTxtPlace): Deployment {
  const record = recordIn(join(storage, 'deployment.json'));
  let last: Promise<unknown> = Promise.resolve();
  return {
    unmanaged(folder) {
      const run = last.then(async () => unmanagedIn(folder, (await record.of(folder)).files));
      last = run.catch(() => undefined);
      return run;
    },
    purge(folder) {
      const run = last.then(() => purgeFrom(record, folder));
      last = run.catch(() => undefined);
      return run;
    },
    deploy(folder, files, plugins) {
      const run = last.then(() => deployTo(record, place, folder, files, plugins));
      last = run.catch(() => undefined);
      return run;
    },
  };
}
