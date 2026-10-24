// The versions of the game's program and its script extender's loader, read from the game folder as the reference mod
// manager reads them.

import { join } from 'node:path';
import { programsOf } from '../../tables/gamePaths';
import { errnoCode } from '../errno';
import { errorMessage } from '../../ports/errorMessage';
import type { GameFolder } from '../instanceAdapter';
import { fileVersionOf, productVersionOf } from './versionResource';

export type ProgramVersion =
  | { readonly kind: 'read'; readonly version: string }
  | { readonly kind: 'notFound'; readonly program: string }
  | { readonly kind: 'unreadable'; readonly why: string };

export interface ProgramVersions {
  readonly game: ProgramVersion;
  readonly extender: ProgramVersion;
}

// The reference takes a game program's product version where its file version starts so, as some games' programs
// carry their true version there alone.
const FALLBACK_GAME_VERSION = '1.0.0';

async function gameVersionOf(path: string): Promise<string> {
  const version = await fileVersionOf(path);
  return version.startsWith(FALLBACK_GAME_VERSION) ? (await productVersionOf(path)) || version : version;
}

async function versionIn(root: string, program: string, read: (path: string) => Promise<string>): Promise<ProgramVersion> {
  try {
    return { kind: 'read', version: await read(join(root, program)) };
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'notFound', program } : { kind: 'unreadable', why: errorMessage(err) };
  }
}

const neither = (why: string): ProgramVersions => ({ game: { kind: 'unreadable', why }, extender: { kind: 'unreadable', why } });

export async function programVersions(gameFolder: GameFolder, release: string | undefined): Promise<ProgramVersions> {
  if (gameFolder.kind !== 'found') return neither('the game folder was not found');
  const programs = programsOf(release);
  if (programs === undefined) return neither('Modbench knows no program of this game');
  const [game, extender] = await Promise.all([
    versionIn(gameFolder.root, programs.game, gameVersionOf),
    versionIn(gameFolder.root, programs.extenderLoader, fileVersionOf),
  ]);
  return { game, extender };
}
