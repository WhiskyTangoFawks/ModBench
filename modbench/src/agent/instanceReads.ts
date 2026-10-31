import type { InstanceValue } from '../instanceLoader/instance';
import { Refusal } from '../drivingLib/refusal';

export interface Read {
  readonly name: string;
  readonly description: string;
  readonly of: (value: InstanceValue) => unknown;
}

export const INSTANCE_READS: readonly Read[] = [
  {
    name: 'list_profiles',
    description: 'Every profile of the instance, and the active one.',
    of: ({ profiles, activeProfile }) => ({ active: activeProfile, profiles }),
  },
  {
    name: 'list_mods',
    description: 'The mods and separators in mod order, winning first, each with whether it is enabled.',
    of: ({ mods }) => mods.map(({ kind, name, enabled }) => ({ kind, name, enabled })),
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
