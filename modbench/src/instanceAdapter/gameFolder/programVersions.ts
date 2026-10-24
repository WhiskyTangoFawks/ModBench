// The versions of the game's program and its script extender's loader, read from the game folder as the reference mod
// manager reads them.

import { join } from 'node:path';
import { programsOf } from '../../tables/gamePaths';
import { errnoCode } from '../errno';
import { errorMessage } from '../../ports/errorMessage';
import type { GameFolder } from '../instanceAdapter';
import { versionResourceOf, type VersionResource } from './versionResource';

/** A program's version; or, named, a program the game folder lacks, one with no version resource, a file that is no
 *  Windows program, or one the file system would not read. */
export type ProgramVersion =
  | { readonly kind: 'read'; readonly version: string }
  | { readonly kind: 'notFound' | 'noVersionResource' | 'notAProgram'; readonly program: string }
  | { readonly kind: 'unreadable'; readonly program: string; readonly why: string };

/** Both versions; or neither, because the game folder was not found, or the game's programs are not known. */
export type ProgramVersions =
  | { readonly kind: 'found'; readonly game: ProgramVersion; readonly extender: ProgramVersion }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unknownGame' };

// The reference takes a game program's product version where its file version starts so, as some games' programs
// carry their true version there alone.
const FALLBACK_GAME_VERSION = '1.0.0';

const gameVersion = ({ fileVersion, productVersion }: Extract<VersionResource, { readonly kind: 'read' }>): string =>
  (fileVersion.startsWith(FALLBACK_GAME_VERSION) && productVersion !== '' ? productVersion : fileVersion);

async function versionIn(
  root: string, program: string, versionOf: (read: Extract<VersionResource, { readonly kind: 'read' }>) => string,
): Promise<ProgramVersion> {
  try {
    const resource = await versionResourceOf(join(root, program));
    return resource.kind === 'read' ? { kind: 'read', version: versionOf(resource) } : { kind: resource.kind, program };
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'notFound', program } : { kind: 'unreadable', program, why: errorMessage(err) };
  }
}

export async function programVersions(gameFolder: GameFolder, release: string | undefined): Promise<ProgramVersions> {
  if (gameFolder.kind !== 'found') return { kind: 'unresolved' };
  const programs = programsOf(release);
  if (programs === undefined) return { kind: 'unknownGame' };
  const [game, extender] = await Promise.all([
    versionIn(gameFolder.root, programs.game, gameVersion),
    versionIn(gameFolder.root, programs.extenderLoader, ({ fileVersion }) => fileVersion),
  ]);
  return { kind: 'found', game, extender };
}
