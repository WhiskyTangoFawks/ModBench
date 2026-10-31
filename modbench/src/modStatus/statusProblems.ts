import { join } from 'node:path';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';
import type { PackagedStatus } from './modStatuses';

/** A problem on the file it concerns. */
export interface StatusProblem {
  readonly file: string;
  readonly message: string;
}

/** Each unfinished state of a mod, on the file it concerns (modlist-repository.md, Status, story 2). */
export function statusProblems(status: ModStatus, folder: string): StatusProblem[] {
  if (status.noManifest) return [{ file: folder, message: 'No manifest.' }];
  const onFiles = (paths: readonly string[], message: string): StatusProblem[] => paths.map((path) => ({ file: join(folder, path), message }));
  const { manifestFile } = status;
  const onManifest = (messages: readonly string[]): StatusProblem[] =>
    (manifestFile === undefined ? [] : messages.map((message) => ({ file: manifestFile, message })));
  return [
    ...onFiles(status.differing, 'Differs from its manifest.'),
    ...onFiles(status.namedByNoLine, 'No line of the mod\'s manifest names this file.'),
    ...onManifest(status.gone.map((path) => `Names '${path}', which the mod's folder lacks.`)),
    ...onManifest(status.notInPackage.map((path) => `No package it names holds the bytes of '${path}'.`)),
    ...onManifest(status.otherBytes.map((path) => `No package it names holds the bytes of '${path}'; one holds a file of its name.`)),
    ...onManifest(status.noHost.map((pkg) => `${pkg.charAt(0).toUpperCase()}${pkg.slice(1)} has no host.`)),
    ...onManifest(status.packagesLacking.map((lacking) => `This machine does not hold a package it names: ${lacking}.`)),
  ];
}

/** A mod made from several packages, on its manifest (modlist-repository.md, Status, story 6). */
export function severalPackagesNote(status: PackagedStatus, holdsPlugin: boolean): StatusProblem | undefined {
  const { packages = [], manifestFile } = status;
  if (packages.length < 2 || manifestFile === undefined) return undefined;
  const upgrade = `An upgrade replaces the files of every one of the ${packages.length} packages: ${packages.join(', ')}.`;
  const decompile = holdsPlugin ? ' To keep edits to its plugin, run Decompile and Commit Mod.' : '';
  return { file: manifestFile, message: `Made from several packages. ${upgrade}${decompile}` };
}
