// MO2's reads of what the game loads beside its plugins: the archives its INIs list, a profile keeping
// its own game INIs when its settings say so, and the archives and strings files of the Data folder.

import { errorMessage } from '../ports/errorMessage';
import { keepsOwnGameInis } from './codecs/profileSettings';
import { archiveListsOf, dataFolderOf, pluginCompanionRule } from '../tables/gamePaths';
import { get, listDir } from './files';
import { archivesListedIn } from './gameIni';
import type { DataFolderArchives, GameFolder, InstanceAdapter } from './instanceAdapter';
import { dataFolderArchivesGlob, fileInFolder, fileNamedGlob, profileDir, profileSettingsFile } from './layout';
import { readOrAbsent, type Mo2Context } from './mo2Context';

// The one spelled as `name` first, then one Windows takes for it.
async function fileNamedIn(folder: string, name: string): Promise<string | undefined> {
  const names = (await readOrAbsent(() => listDir(folder), [])).filter((d) => d.isFile()).map((d) => d.name);
  const spelled = names.find((entry) => entry === name) ?? names.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return spelled === undefined ? undefined : fileInFolder(folder, spelled);
}

const textOf = async (file: string | undefined): Promise<string[]> =>
  (file === undefined ? [] : [await readOrAbsent(() => get(file), '')]);

async function listGameFolderArchives(dataFolder: string, gameRelease: string | undefined): Promise<DataFolderArchives> {
  const rule = pluginCompanionRule(gameRelease);
  try {
    const dirents = await listDir(dataFolder);
    if (rule === undefined) return { kind: 'listed', archives: [], stringsFiles: [] };
    const archives = dirents.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(rule.archiveExtension)).map((d) => d.name);
    const stringsFolders = dirents.filter((d) => d.isDirectory() && d.name.toLowerCase() === rule.stringsFolder).map((d) => d.name);
    const stringsFiles = await Promise.all(stringsFolders.map(async (folder) => (await listDir(fileInFolder(dataFolder, folder)))
      .filter((d) => d.isFile() && rule.isStringsFile(d.name))
      .map((d) => `${folder}/${d.name}`)));
    return { kind: 'listed', archives, stringsFiles: stringsFiles.flat() };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}

export function mo2Archives({ instanceRoot, watch }: Mo2Context): Pick<InstanceAdapter, 'archiveList' | 'gameFolderArchives'> {
  return {
    async archiveList(profile, gameFolder: GameFolder, gameRelease) {
      const lists = archiveListsOf(gameRelease);
      if (gameFolder.kind !== 'found' || lists === undefined) {
        watch.follow('defaultIni', undefined, '');
        return { archives: [], notes: [] };
      }
      watch.follow('defaultIni', gameFolder.root, fileNamedGlob(lists.defaultIni));
      const keepsOwn = keepsOwnGameInis(await readOrAbsent(() => get(profileSettingsFile(instanceRoot, profile)), ''));
      const own = keepsOwn ? lists.userInis.map((name) => fileNamedIn(profileDir(instanceRoot, profile), name)) : [];
      const files = await Promise.all([fileNamedIn(gameFolder.root, lists.defaultIni), ...own]);
      return {
        archives: archivesListedIn((await Promise.all(files.map(textOf))).flat(), lists.keys),
        notes: keepsOwn ? [] : [`The profile ${profile} keeps no game INIs of its own: the archives listed are its default INI's, and none the game's own INIs add.`],
      };
    },

    gameFolderArchives(gameFolder, gameRelease) {
      const rule = pluginCompanionRule(gameRelease);
      const dataFolder = dataFolderOf(gameFolder);
      watch.follow('gameFolderArchives', rule && dataFolder, rule ? dataFolderArchivesGlob(rule.archiveExtension, rule.stringsFolder) : '');
      return dataFolder === undefined ? Promise.resolve({ kind: 'unresolved' }) : listGameFolderArchives(dataFolder, gameRelease);
    },
  };
}
