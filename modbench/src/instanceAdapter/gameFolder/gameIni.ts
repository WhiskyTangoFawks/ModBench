// The game's own INI format: `[section]` headers, `key=value` lines and `;` comments, sections and
// keys matched without case. Any mod manager's implementation reads the game's INIs through it.

import { splitLines, stripBom } from '../../loadOrderFileCodec/lineScan';
import type { ArchiveLists } from '../../tables/gamePaths';

const ARCHIVE_SECTION = 'archive';

// A later line, and a later INI, replaces a key's value.
function archiveKeysIn(text: string, values: Map<string, string>): void {
  let section: string | undefined;
  for (const line of splitLines(stripBom(text)).map((raw) => raw.trim())) {
    if (line.startsWith('[') && line.endsWith(']')) section = line.slice(1, -1).trim().toLowerCase();
    else if (section === ARCHIVE_SECTION && !line.startsWith(';') && line.includes('=')) {
      const eq = line.indexOf('=');
      values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1));
    }
  }
}

/** The archives `keys` list in `[Archive]`, key by key, as the INIs give them read in order. */
export function archivesListedIn(inis: readonly string[], { keys }: Pick<ArchiveLists, 'keys'>): string[] {
  const values = new Map<string, string>();
  for (const text of inis) archiveKeysIn(text, values);
  return keys.flatMap((key) => (values.get(key.toLowerCase()) ?? '').split(',').map((name) => name.trim()).filter((name) => name !== ''));
}
