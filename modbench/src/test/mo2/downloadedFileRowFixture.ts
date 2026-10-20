import { join } from 'node:path';
import type { LocatedDownloadedFileRow, DownloadedFileRow } from '../../instanceLoader/instance';

/** A `LocatedDownloadedFileRow` with every required member at its neutral value, the two paths named as a
 *  recompute over `instanceRoot` names them. */
export function downloadedFileRowFixture(
  name: string, overrides: Partial<DownloadedFileRow> = {}, instanceRoot = '/instance',
): LocatedDownloadedFileRow {
  return {
    name,
    displayName: name,
    status: 'Downloaded',
    size: 100,
    mtimeMs: 1700000000000,
    hasMeta: false,
    excluded: false,
    upgrades: [],
    ...overrides,
    path: join(instanceRoot, 'downloads', name),
    metadataPath: join(instanceRoot, 'downloads', name + '.meta'),
  };
}
