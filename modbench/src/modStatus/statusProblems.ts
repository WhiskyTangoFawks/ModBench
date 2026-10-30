import { join } from 'node:path';
import type { ModStatus } from '../manifestAdapter/manifestAdapter';

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
    ...onManifest(status.notInPackage.map((path) => `Its package does not hold '${path}'.`)),
    ...onManifest(status.otherBytes.map((path) => `Its package holds '${path}' with other bytes.`)),
    ...onManifest(status.metadataDiffers ? ['The mod\'s metadata differs from this manifest.'] : []),
    ...onManifest(status.noHost ? ['Its package has no host.'] : []),
    ...onManifest(status.packagesLacking.map((lacking) => `This machine does not hold a package it pins: ${lacking}.`)),
  ];
}
