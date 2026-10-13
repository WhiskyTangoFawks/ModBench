// Where the game keeps its own copies of its INIs: the release's folder under `Documents/My Games`.
// Windows asks the Documents known folder; Linux looks in the game's Steam prefix, then in the Wine
// prefix holding the instance.

import { userInfo } from 'node:os';
import { join, posix } from 'node:path';
import { archiveListsOf, gamePathInfoForRelease } from '../tables/gamePaths';
import { errorMessage } from '../ports/errorMessage';
import { factsOf } from './files';
import type { GameDetectors } from './gameDirectory';

type MyGamesResolution = { readonly kind: 'found'; readonly folder: string } | { readonly kind: 'notFound'; readonly looked: readonly string[] };

/** Answers where the release's My Games folder is, with each place looked at when it is nowhere. */
export type MyGamesResolver = (release: string | undefined) => Promise<MyGamesResolution>;

const MY_GAMES = 'My Games';
const PROTON_USER = 'steamuser';
const WINE_DRIVE = 'drive_c';

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await factsOf(path)).kind === 'directory';
  } catch {
    return false;
  }
}

async function firstFolder(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await isFolder(candidate)) return candidate;
  return undefined;
}

const inPrefix = (prefix: string, folderName: string): Promise<string | undefined> =>
  firstFolder([PROTON_USER, userInfo().username].map((user) => posix.join(prefix, WINE_DRIVE, 'users', user, 'Documents', MY_GAMES, folderName)));

// The prefix is what lies above the `drive_c` the instance sits under.
function prefixHolding(instanceRoot: string): string | undefined {
  const segments = instanceRoot.split('/');
  const drive = segments.indexOf(WINE_DRIVE);
  return drive === -1 ? undefined : segments.slice(0, drive).join('/') || '/';
}

async function windowsResolution(documentsFolder: () => Promise<string>, folderName: string): Promise<MyGamesResolution> {
  const place = 'the Documents folder';
  let documents: string;
  try {
    documents = await documentsFolder();
  } catch (err) {
    return { kind: 'notFound', looked: [`${place}: ${errorMessage(err)}`] };
  }
  const folder = join(documents, MY_GAMES, folderName);
  return (await isFolder(folder))
    ? { kind: 'found', folder }
    : { kind: 'notFound', looked: [`${place}, ${documents}: no ${MY_GAMES}/${folderName} folder in it`] };
}

async function linuxResolution(instanceRoot: string, detectors: GameDetectors, release: string, folderName: string): Promise<MyGamesResolution> {
  const looked: string[] = [];
  const appId = gamePathInfoForRelease(release)?.steamAppId;
  if (appId === undefined) looked.push('the Steam prefix: Modbench has no Steam entry for this game');
  else {
    const steamPrefix = await detectors.winePrefix(appId);
    const place = `the Steam prefix of app ${appId}`;
    if (steamPrefix === null) looked.push(`${place}: the game is in no Steam library`);
    else {
      const folder = await inPrefix(steamPrefix, folderName);
      if (folder !== undefined) return { kind: 'found', folder };
      looked.push(`${place}, ${steamPrefix}: no ${MY_GAMES}/${folderName} folder in its Documents`);
    }
  }
  const place = 'the Wine prefix holding the instance';
  const winePrefix = prefixHolding(instanceRoot);
  if (winePrefix === undefined) looked.push(`${place}: ${instanceRoot} is under no ${WINE_DRIVE}`);
  else {
    const folder = await inPrefix(winePrefix, folderName);
    if (folder !== undefined) return { kind: 'found', folder };
    looked.push(`${place}, ${winePrefix}: no ${MY_GAMES}/${folderName} folder in its Documents`);
  }
  return { kind: 'notFound', looked };
}

export function myGamesResolver(instanceRoot: string, detectors: GameDetectors, platform: NodeJS.Platform = process.platform): MyGamesResolver {
  let documentsFolder: string | undefined;
  const askDocumentsOnce = async (): Promise<string> => (documentsFolder ??= await detectors.documents());
  return async (release) => {
    const folderName = archiveListsOf(release)?.myGamesFolder;
    if (release === undefined || folderName === undefined) return { kind: 'notFound', looked: [] };
    return platform === 'win32' ? windowsResolution(askDocumentsOnce, folderName) : linuxResolution(instanceRoot, detectors, release, folderName);
  };
}
