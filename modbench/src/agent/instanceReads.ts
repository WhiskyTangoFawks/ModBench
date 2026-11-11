import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import type { Source } from './source';
import type { PluginsTxtWhere } from '../deployment/pluginsTxtPlace';
import { FILTER, filterNarrows, fitting, holding } from './tooLarge';

/** The deployment the Toolbox shows: its folder, and where deploy writes plugins.txt for a game and that folder. */
export interface DeploymentRead {
  folder(): string | undefined;
  pluginsTxtPlace(gameName: string, folder: string): Promise<PluginsTxtWhere>;
}

async function deploymentOf(deployment: DeploymentRead, gameName: string) {
  const folder = deployment.folder();
  return folder === undefined ? { folder: null } : { folder, pluginsTxt: await deployment.pluginsTxtPlace(gameName, folder) };
}

export const LIST_PROFILES = {
  name: 'list_profiles',
  of: async ({ profiles, activeProfile, gameName, gameFolder, programVersions, gameFolderLinks, holdsRepository }: InstanceValue, deployment: DeploymentRead) => ({
    active: activeProfile, profiles,
    game: { name: gameName, folder: gameFolder, versions: programVersions },
    gameFolderLinks, holdsRepository,
    deployment: await deploymentOf(deployment, gameName),
  }),
};

export interface InstanceList {
  readonly name: string;
  /** The sources whose standing lines ride on the reply. */
  readonly reads: readonly Source[];
  readonly input: typeof FILTER;
  readonly of: (value: InstanceValue, args: { filter?: string }) => unknown;
}

export const INSTANCE_LISTS: readonly InstanceList[] = [
  {
    name: 'list_mods',
    reads: ['instance', 'modList'],
    input: FILTER,
    of: ({ mods, overwriteFiles, listedSourceMods, paths }, { filter }) => fitting([
      { kind: 'runtimeOutput', name: OVERWRITE_LABEL, fileCount: overwriteFiles.length },
      ...mods.map((entry) => (entry.kind === 'separator'
        ? { kind: entry.kind, name: entry.name, enabled: entry.enabled }
        : {
          kind: entry.kind, name: entry.name, enabled: entry.enabled, version: entry.version, updateAvailable: entry.updateAvailable,
          nexusId: entry.nexusId, installationFileName: entry.installationFileName,
          sourceFolder: listedSourceMods.has(entry.name) ? paths.sourceDirs.get(entry.name) : undefined,
        })),
    ].filter(({ name }) => holding(filter)(name)), (rows) => filterNarrows({ mods: rows.length }, 'the mods and separators whose name holds it')),
  },
  {
    name: 'list_downloads',
    reads: ['instance'],
    input: FILTER,
    of: ({ downloadedFiles }, { filter }) => {
      if (downloadedFiles.kind === 'unresolved') throw new Refusal(downloadedFiles.reason);
      const held = holding(filter);
      return fitting(downloadedFiles.rows.filter(({ name, displayName }) => held(name) || held(displayName)).map((row) => ({
        name: row.name, displayName: row.displayName, status: row.status, excluded: row.excluded, hasMeta: row.hasMeta,
        size: row.size, mtimeMs: row.mtimeMs, modID: row.modID, fileID: row.fileID, version: row.version,
        modName: row.modName, gameName: row.gameName, author: row.author, upgrades: row.upgrades,
      })), (rows) => filterNarrows({ downloads: rows.length }, 'the downloaded files whose name or displayName holds it'));
    },
  },
];
