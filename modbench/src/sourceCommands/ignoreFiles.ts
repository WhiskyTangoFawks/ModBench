import type { InstanceAdapter, FileOrigin } from '../instanceAdapter/instanceAdapter';
import { exclusionsOfFiles, isUnderAny, sourceModsOf, writeManifestIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import { gestureWord } from '../wire/gestureWords';
import { heldManifestIn } from './heldManifest';
import { updateManifest, type UpdateManifestDeps } from './updateManifest';

type Adapter = UpdateManifestDeps['adapter'] & Pick<InstanceAdapter, 'modFolderPath' | 'ownPath'>;

export interface IgnoreFilesDeps {
  readonly adapter: Adapter;
}

/** A file of a mod, or of Overwrite, by its path there. */
export interface FileToIgnore {
  readonly origin: FileOrigin;
  readonly relativePath: string;
}

interface FileOfMod {
  readonly file: FileToIgnore;
  readonly path: string;
}

// formats/manifest.md: no ignored path is a file the manifest records, so ignoring a file drops its line.
function ignoring(held: Manifest, paths: readonly string[]): Manifest {
  const ignore = [...held.ignore, ...paths.filter((path) => !isUnderAny(held.ignore, path))];
  const files = new Map([...held.files].filter(([path]) => !isUnderAny(ignore, path)));
  return { ...held, ignore, exclude: exclusionsOfFiles(held.exclude, files.keys()), files };
}

// A file under an ignored folder has no entry of its own to remove.
const whyNotUnignored = (held: Manifest, path: string): string | undefined => {
  const above = held.ignore.find((ignored) => ignored !== path && isUnderAny([ignored], path));
  return above === undefined ? undefined : `its manifest ignores '${above}', a folder above it`;
};

const unignoring = (held: Manifest, paths: readonly string[]): Manifest => ({ ...held, ignore: held.ignore.filter((ignored) => !paths.includes(ignored)) });

// The files of one mod its manifest change takes, and those it refuses, each with why.
async function changedFor(
  adapter: Adapter, mod: string, ofMod: readonly FileOfMod[], ignore: boolean,
): Promise<{ readonly taken: readonly FileOfMod[]; readonly refused: readonly ItemRefusal<FileToIgnore>[] }> {
  const refuseAll = (reason: string) => ({ taken: [], refused: ofMod.map(({ file }) => ({ item: file, reason })) });
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return refuseAll(`'${mod}' is gone from the disk`);
  const held = await heldManifestIn(folder);
  if (held === undefined) return refuseAll(`its mod has no manifest, so ${gestureWord('modbench.mod.updateManifest')} comes first`);
  if ('why' in held) return refuseAll(held.why);
  const refused = ofMod.flatMap(({ file, path }) => {
    const reason = ignore ? undefined : whyNotUnignored(held, path);
    return reason === undefined ? [] : [{ item: file, reason }];
  });
  const taken = ofMod.filter(({ file }) => !refused.some(({ item }) => item === file));
  if (taken.length === 0) return { taken, refused };
  const paths = taken.map(({ path }) => path);
  try {
    await writeManifestIn(folder, ignore ? ignoring(held, paths) : unignoring(held, paths));
    return { taken, refused };
  } catch (err) {
    return refuseAll(`its manifest could not be written: ${errorMessage(err)}`);
  }
}

/** Ignores each file in its mod's manifest, or puts it back and records that file's line alone. A source mod's folder is
 *  recorded by its build. Each file lands or is refused on its own. */
export async function ignoreFiles(
  deps: IgnoreFilesDeps & UpdateManifestDeps, files: readonly FileToIgnore[], ignore: boolean,
): Promise<SelectionOutcome<FileToIgnore>> {
  const { adapter } = deps;
  const landed: FileToIgnore[] = [];
  const refused: ItemRefusal<FileToIgnore>[] = [];
  const byMod = new Map<string, FileOfMod[]>();
  for (const file of files) {
    if (file.origin.kind !== 'mod') { refused.push({ item: file, reason: 'Overwrite is not a mod.' }); continue; }
    byMod.set(file.origin.name, [...byMod.get(file.origin.name) ?? [], { file, path: adapter.ownPath(file.relativePath) }]);
  }
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const written = new Map<string, FileOfMod[]>();
  for (const [mod, ofMod] of byMod) {
    const changed = await changedFor(adapter, mod, ofMod, ignore);
    refused.push(...changed.refused);
    if (changed.taken.length > 0) written.set(mod, [...changed.taken]);
  }
  const toRecord = ignore ? [] : [...written].filter(([mod]) => sourceMods.folderOf(mod) === undefined);
  const recorded = toRecord.length === 0
    ? undefined
    : await updateManifest(deps, toRecord.map(([mod]) => mod), { only: new Map(toRecord.map(([mod, ofMod]) => [mod, ofMod.map(({ path }) => path)])) }, [], false, []);
  const notRecorded = new Map(recorded?.refused.map(({ item, reason }) => [item, reason]));
  for (const [mod, ofMod] of written) {
    const reason = notRecorded.get(mod);
    for (const { file } of ofMod) {
      if (reason === undefined) landed.push(file);
      else refused.push({ item: file, reason: `its manifest was written, but ${reason}` });
    }
  }
  return { landed, refused };
}
