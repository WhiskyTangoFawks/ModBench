import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import type { PluginsTxtWhere } from '../deployment/pluginsTxtPlace';

/** The deployment the Toolbox shows: its folder, and where deploy writes plugins.txt for a game and that folder. */
export interface DeploymentRead {
  folder(): string | undefined;
  pluginsTxtPlace(gameName: string, folder: string): Promise<PluginsTxtWhere>;
}

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue, deployment: DeploymentRead) => unknown;
}

async function deploymentOf(deployment: DeploymentRead, gameName: string) {
  const folder = deployment.folder();
  return folder === undefined ? { folder: null } : { folder, pluginsTxt: await deployment.pluginsTxtPlace(gameName, folder) };
}

export const INSTANCE_READS: readonly Read[] = [
  {
    name: 'list_profiles',
    description: 'Every profile of the instance and the active one, and the Toolbox: the game (its folder, or each place Modbench looked), the game and script extender versions, how many game folder files are links Modbench ignores, whether the modlist holds a repository, the deployment folder and where deploy writes plugins.txt.',
    of: async ({ profiles, activeProfile, gameName, gameFolder, programVersions, gameFolderLinks, holdsRepository }, deployment) => ({
      active: activeProfile, profiles,
      game: { name: gameName, folder: gameFolder, versions: programVersions },
      gameFolderLinks, holdsRepository,
      deployment: await deploymentOf(deployment, gameName),
    }),
  },
  {
    name: 'list_mods',
    description: 'The Overwrite row, which wins over every mod, with its file count, then the mods and separators in mod order, winning first, each with whether it is enabled. '
      + 'A mod also has what its row shows: version, whether an update is available, its Nexus ID, the file it was installed from, and the source folder it is built from if it is a source mod. '
      + 'Its status against its manifest is list_mod_statuses.',
    of: ({ mods, overwriteFiles, listedSourceMods, paths }) => [
      { kind: 'runtimeOutput', name: OVERWRITE_LABEL, fileCount: overwriteFiles.length },
      ...mods.map((entry) => (entry.kind === 'separator'
        ? { kind: entry.kind, name: entry.name, enabled: entry.enabled }
        : {
          kind: entry.kind, name: entry.name, enabled: entry.enabled, version: entry.version, updateAvailable: entry.updateAvailable,
          nexusId: entry.nexusId, installationFileName: entry.installationFileName,
          sourceFolder: listedSourceMods.has(entry.name) ? paths.sourceDirs.get(entry.name) : undefined,
        })),
    ],
  },
  {
    name: 'list_downloads',
    description: 'The downloaded files by file name, each as its row shows it: display name, status, whether it is excluded and has metadata, size, modified time (ms), mod ID, file ID, version, mod name, game and author, and its upgrade targets (installed mods it can upgrade, best match first, each with its tier).',
    of: ({ downloadedFiles }) => {
      if (downloadedFiles.kind === 'unresolved') throw new Refusal(downloadedFiles.reason);
      return downloadedFiles.rows.map((row) => ({
        name: row.name, displayName: row.displayName, status: row.status, excluded: row.excluded, hasMeta: row.hasMeta,
        size: row.size, mtimeMs: row.mtimeMs, modID: row.modID, fileID: row.fileID, version: row.version,
        modName: row.modName, gameName: row.gameName, author: row.author, upgrades: row.upgrades,
      }));
    },
  },
];
