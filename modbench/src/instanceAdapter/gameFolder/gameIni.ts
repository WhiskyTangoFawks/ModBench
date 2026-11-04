// The game's own INI format: `[section]` headers, `key=value` lines and `;` comments, sections and
// keys matched without case. Any mod manager's implementation reads the game's INIs through it.

import { splitLines, stripBom } from '../../loadOrderFileCodec/lineScan';
import type { ArchiveLists } from '../../tables/gamePaths';

const ARCHIVE_SECTION = 'archive';

/** The `[Archive]` keys an INI sets, by lower-cased key. */
export function archiveKeysIn(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let section: string | undefined;
  for (const line of splitLines(stripBom(text)).map((raw) => raw.trim())) {
    if (line.startsWith('[') && line.endsWith(']')) section = line.slice(1, -1).trim().toLowerCase();
    else if (section === ARCHIVE_SECTION && !line.startsWith(';') && line.includes('=')) {
      const eq = line.indexOf('=');
      values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1));
    }
  }
  return values;
}

/** The archives `keys` list in `[Archive]`, key by key, as the INIs give them read in order: a later INI replaces a key's value. */
export function archivesListedIn(inis: readonly ReadonlyMap<string, string>[], { keys }: Pick<ArchiveLists, 'keys'>): string[] {
  const values = new Map(inis.flatMap((ini) => [...ini]));
  return keys.flatMap((key) => (values.get(key.toLowerCase()) ?? '').split(',').map((name) => name.trim()).filter((name) => name !== ''));
}
