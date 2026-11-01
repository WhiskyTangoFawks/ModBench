import type { InstanceAdapter, FileOrigin } from '../instanceAdapter/instanceAdapter';
import { exclusionsOfFiles, isUnderAny, manifestIn, writeManifestIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
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

const NO_MANIFEST: Manifest = { packages: [], exclude: [], ignore: [], files: new Map() };

// A manifest of the format before version 1 is written over, as update manifest does.
async function heldManifestIn(folder: string): Promise<Manifest | { readonly refusal: string }> {
  try {
    const held = await manifestIn(folder);
    if (held === undefined || 'olderFormat' in held) return NO_MANIFEST;
    return 'refused' in held ? { refusal: `${held.refused}.` } : held.manifest;
  } catch (err) {
    return { refusal: `its manifest could not be read: ${errorMessage(err)}` };
  }
}

// formats/manifest.md: no ignored path is a file the manifest records, so ignoring a file drops its line.
function ignoring(held: Manifest, paths: readonly string[]): Manifest {
  const ignore = [...held.ignore, ...paths.filter((path) => !isUnderAny(held.ignore, path))];
  const files = new Map([...held.files].filter(([path]) => !isUnderAny(ignore, path)));
  return { ...held, ignore, exclude: exclusionsOfFiles(held.exclude, files), files };
}

function unignoring(held: Manifest, paths: readonly string[]): Manifest | { readonly refusal: string } {
  const above = paths.flatMap((path) => held.ignore.filter((ignored) => ignored !== path && isUnderAny([ignored], path)));
  if (above[0] !== undefined) return { refusal: `its manifest ignores '${above[0]}', a folder above it` };
  return { ...held, ignore: held.ignore.filter((ignored) => !paths.includes(ignored)) };
}

async function manifestChanged(
  adapter: Adapter, mod: string, ignore: boolean, paths: readonly string[],
): Promise<{ readonly refusal: string } | undefined> {
  const folder = await adapter.modFolderPath(mod);
  if (folder === undefined) return { refusal: `'${mod}' is gone from the disk` };
  const held = await heldManifestIn(folder);
  if ('refusal' in held) return held;
  const changed = ignore ? ignoring(held, paths) : unignoring(held, paths);
  if ('refusal' in changed) return changed;
  try {
    await writeManifestIn(folder, changed);
    return undefined;
  } catch (err) {
    return { refusal: `its manifest could not be written: ${errorMessage(err)}` };
  }
}

/** Ignores each file in its mod's manifest, or puts it back, then records the manifest of each mod it changed, as update
 *  manifest does. A mod's files land or are refused together. */
export async function ignoreFiles(
  deps: IgnoreFilesDeps & UpdateManifestDeps, files: readonly FileToIgnore[], ignore: boolean,
): Promise<SelectionOutcome<FileToIgnore>> {
  const { adapter } = deps;
  const landed: FileToIgnore[] = [];
  const refused: ItemRefusal<FileToIgnore>[] = [];
  const byMod = new Map<string, FileToIgnore[]>();
  for (const file of files) {
    if (file.origin.kind !== 'mod') { refused.push({ item: file, reason: 'Overwrite is not a mod.' }); continue; }
    byMod.set(file.origin.name, [...byMod.get(file.origin.name) ?? [], file]);
  }
  const written: string[] = [];
  for (const [mod, ofMod] of byMod) {
    const refusal = await manifestChanged(adapter, mod, ignore, ofMod.map(({ relativePath }) => adapter.ownPath(relativePath)));
    if (refusal === undefined) written.push(mod);
    else refused.push(...ofMod.map((item) => ({ item, reason: refusal.refusal })));
  }
  const recorded = written.length === 0 ? undefined : await updateManifest(deps, written, {}, [], false, []);
  const notRecorded = new Map(recorded?.refused.map(({ item, reason }) => [item, reason]));
  for (const mod of written) {
    const reason = notRecorded.get(mod);
    for (const item of byMod.get(mod) ?? []) {
      if (reason === undefined) landed.push(item);
      else refused.push({ item, reason: `its manifest was written, but ${reason}` });
    }
  }
  return { landed, refused };
}
