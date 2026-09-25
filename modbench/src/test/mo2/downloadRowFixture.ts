import { join } from 'node:path';
import type { DownloadRow } from '../../mo2Codecs/downloads';
import type { DownloadFile } from '../../instanceLoader/instance';

/** A `DownloadFile` with every required member at its neutral value, the two paths named as a
 *  recompute over `instanceRoot` names them. */
export function downloadRowFixture(
  name: string, overrides: Partial<DownloadRow> = {}, instanceRoot = '/instance',
): DownloadFile {
  return {
    name,
    displayName: name,
    status: 'Downloaded',
    size: 100,
    mtimeMs: 1700000000000,
    hasMeta: false,
    excluded: false,
    ...overrides,
    path: join(instanceRoot, 'downloads', name),
    sidecarPath: join(instanceRoot, 'downloads', name + '.meta'),
  };
}
