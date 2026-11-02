import { mkdir } from 'node:fs/promises';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import { writeManifestIn } from '../manifestAdapter/manifestAdapter';

/** A mod whose folder matches its manifest, but for what `over` says. */
export const status = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, packages: [], noManifest: false, differing: [], namedByNoLine: [], ignored: [], ignoreEntries: [], gone: [], notInPackage: [], otherBytes: [], noHost: [], packagesLacking: [], ...over });

/** A hash a manifest records, of bytes no test writes. */
export const RECORDED_HASH = 'AAAAAAAAAAA=';

/** Writes into `folder` the manifest named for it, naming each of `paths` and no package. */
export async function manifestedIn(folder: string, paths: readonly string[] = []): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeManifestIn(folder, { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map(paths.map((path) => [path, RECORDED_HASH])) });
}
