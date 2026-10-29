import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { manifestText, type ManifestFile, type ModStatus } from '../manifestAdapter/manifestAdapter';

/** A mod whose folder matches its manifest, but for what `over` says. */
export const status = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false, ...over });

/** Writes into `folder` the manifest named for it, holding `files` and no package. */
export async function manifestedIn(folder: string, files: readonly ManifestFile[] = []): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${basename(folder)}.manifest.json`), manifestText({ packages: [], exclude: [], archives: [], steps: [], tools: [], files }));
}
