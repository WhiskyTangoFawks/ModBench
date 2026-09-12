import type { ColumnKey } from './types';

// Mirrors the backend's `ColumnKey.Of`: `|` delimiter (illegal in a Windows filename), Data
// origin elided. Only the Data check case-folds; the key keeps the caller's casing.

/** ADR-0012's one mint point for `ColumnKey` — the only cast to the brand. A `null` origin is
 *  tolerated: the wire schema types every string nullable, though the C# field is NOT NULL. */
export function columnKey(plugin: string, origin: string | null): ColumnKey {
  const resolvedOrigin = origin ?? 'Data';
  const key = resolvedOrigin.toLowerCase() === 'data' ? plugin : `${plugin}|${resolvedOrigin}`;
  return key as ColumnKey;
}
