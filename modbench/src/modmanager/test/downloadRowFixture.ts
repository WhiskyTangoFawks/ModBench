import type { DownloadRow } from '../mo2/downloads';

/** A `DownloadRow` with every required wire member at its neutral value. */
export function downloadRowFixture(name: string, overrides: Partial<DownloadRow> = {}): DownloadRow {
  return {
    name,
    displayName: name,
    status: 'Downloaded',
    size: 100,
    mtimeMs: 1700000000000,
    hasMeta: false,
    hidden: false,
    ...overrides,
  };
}
