import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import type { Source } from './source';
import type { PluginsTxtWhere } from '../deployment/pluginsTxtPlace';

/** The deployment the Toolbox shows: its folder, and where deploy writes plugins.txt for a game and that folder. */
export interface DeploymentRead {
  folder(): string | undefined;
  pluginsTxtPlace(gameName: string, folder: string): Promise<PluginsTxtWhere>;
}

export interface Read {
  readonly name: string;
  /** The sources whose standing lines ride on the reply. */
  readonly reads: readonly Source[];
  readonly of: (value: InstanceValue, deployment: DeploymentRead) => unknown;
}

async function deploymentOf(deployment: DeploymentRead, gameName: string) {
  const folder = deployment.folder();
  return folder === undefined ? { folder: null } : { folder, pluginsTxt: await deployment.pluginsTxtPlace(gameName, folder) };
}

export const INSTANCE_READS: readonly Read[] = [
  {
    name: 'list_profiles',
    reads: ['instance'],
    of: async ({ profiles, activeProfile, gameName, gameFolder, programVersions, gameFolderLinks, holdsRepository }, deployment) => ({
      active: activeProfile, profiles,
      game: { name: gameName, folder: gameFolder, versions: programVersions },
      gameFolderLinks, holdsRepository,
      deployment: await deploymentOf(deployment, gameName),
    }),
  },
  {
    name: 'list_mods',
    reads: ['instance', 'modList'],
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
    reads: ['instance'],
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
