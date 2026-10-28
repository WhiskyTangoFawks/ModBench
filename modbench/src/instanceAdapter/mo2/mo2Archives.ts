// MO2's reads of what the game loads beside its plugins: the archives its INIs list, a profile keeping
// its own game INIs when its settings say so, and the archives and strings files of the Data folder.

import { keepsOwnGameInis } from './codecs/profileSettings';
import { archiveListsOf, pluginCompanionRule } from '../../tables/gamePaths';
import { dataFolderOf } from '../gameFolder/dataFolder';
import { get, ignoreSkippedLink, listEntries, readOrAbsent, readOrReason } from '../files';
import { listOwnEntries, type IgnoredLink } from '../gameFolder/ownEntries';
import { archivesListedIn } from '../gameFolder/gameIni';
import { anyCase, fileInFolder, type DataFolderArchives } from '../instanceAdapter';
import { dataFolderArchivesGlob, profileDir, profileSettingsFile } from './layout';
import type { ArchiveReads } from '../instanceReading';
import type { Mo2Context } from './mo2Context';

// The one spelled as `name` first, then one Windows takes for it.
async function fileNamedIn(folder: string, name: string): Promise<string | undefined> {
  const names = (await readOrAbsent(() => listEntries(folder, ignoreSkippedLink), [])).filter((d) => d.isFile).map((d) => d.name);
  const spelled = names.find((entry) => entry === name) ?? names.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return spelled === undefined ? undefined : fileInFolder(folder, spelled);
}

const textOf = async (file: string | undefined): Promise<string[]> =>
  (file === undefined ? [] : [await readOrAbsent(() => get(file), '')]);

async function listGameFolderArchives(dataFolder: string, gameRelease: string | undefined, ignoredLink: IgnoredLink): Promise<DataFolderArchives> {
  const rule = pluginCompanionRule(gameRelease);
  const listing = await readOrReason(async () => {
    const dirents = await listOwnEntries(dataFolder, ignoredLink);
    if (rule === undefined) return { archives: [], stringsFiles: [] };
    const archives = dirents.filter((d) => d.isFile && rule.isArchive(d.name)).map((d) => d.name);
    const stringsFolders = dirents.filter((d) => d.isDirectory && d.name.toLowerCase() === rule.stringsFolder).map((d) => d.name);
    const stringsFiles = await Promise.all(stringsFolders.map(async (folder) => (await listOwnEntries(fileInFolder(dataFolder, folder), ignoredLink))
      .map((d) => ({ d, relativePath: `${folder}/${d.name}` }))
      .filter(({ d, relativePath }) => d.isFile && rule.isStringsFile(relativePath))
      .map(({ relativePath }) => relativePath)));
    return { archives, stringsFiles: stringsFiles.flat() };
  });
  return listing.kind === 'read' ? { kind: 'listed', ...listing.answer } : listing;
}

async function gameInisFolder(
  { instanceRoot, resolveMyGames, watch }: Mo2Context, profile: string, release: string | undefined, userInis: readonly string[],
): Promise<{ folder: string | undefined; notes: string[] }> {
  const keepsOwn = keepsOwnGameInis(await readOrAbsent(() => get(profileSettingsFile(instanceRoot, profile)), ''));
  if (keepsOwn) {
    watch.follow('myGamesInis', undefined, '');
    return { folder: profileDir(instanceRoot, profile), notes: [] };
  }
  const myGames = await resolveMyGames(release);
  if (myGames.kind === 'found') {
    watch.follow('myGamesInis', myGames.folder, `{${userInis.map(anyCase).join(',')}}`);
    return { folder: myGames.folder, notes: [] };
  }
  watch.follow('myGamesInis', undefined, '');
  return {
    folder: undefined,
    notes: [`The profile ${profile} keeps no game INIs of its own, and the game's were not found: the archives listed are its default INI's. Looked at ${myGames.looked.join('; ')}.`],
  };
}

export function mo2Archives(context: Mo2Context): ArchiveReads {
  const { watch } = context;
  return {
    async archiveList(profile, gameFolder, gameRelease) {
      const lists = archiveListsOf(gameRelease);
      if (gameFolder.kind !== 'found' || lists === undefined) {
        watch.follow('defaultIni', undefined, '');
        watch.follow('myGamesInis', undefined, '');
        return { archives: [], notes: [] };
      }
      watch.follow('defaultIni', gameFolder.root, anyCase(lists.defaultIni));
      const { folder, notes } = await gameInisFolder(context, profile, gameRelease, lists.userInis);
      const own = folder === undefined ? [] : lists.userInis.map((name) => fileNamedIn(folder, name));
      const files = await Promise.all([fileNamedIn(gameFolder.root, lists.defaultIni), ...own]);
      return { archives: archivesListedIn((await Promise.all(files.map(textOf))).flat(), lists), notes };
    },

    gameFolderArchives(gameFolder, gameRelease, ignoredLink) {
      const rule = pluginCompanionRule(gameRelease);
      const dataFolder = dataFolderOf(gameFolder);
      watch.follow('gameFolderArchives', rule && dataFolder, rule ? dataFolderArchivesGlob(rule.archiveExtension, rule.stringsFolder) : '');
      return dataFolder === undefined ? Promise.resolve({ kind: 'unresolved' }) : listGameFolderArchives(dataFolder, gameRelease, ignoredLink);
    },
  };
}
