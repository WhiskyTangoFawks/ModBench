import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOrAbsent } from '../files';

/** A store depot the game's install records, by its id, and the ID Steam gives the version installed. */
export interface SteamDepot {
  readonly id: string;
  readonly version: string;
}

interface VdfMap {
  readonly [key: string]: string | VdfMap;
}

const TOKEN = /"((?:[^"\\]|\\.)*)"|([{}])/g;

function parseMap(tokens: readonly string[], from: number): { map: VdfMap; next: number } {
  const map: Record<string, string | VdfMap> = {};
  let at = from;
  while (at < tokens.length && tokens[at] !== '}') {
    const key = tokens[at++] ?? '';
    if (tokens[at] === '{') {
      const nested = parseMap(tokens, at + 1);
      map[key] = nested.map;
      at = nested.next;
    } else map[key] = tokens[at++] ?? '';
  }
  return { map, next: at + 1 };
}

const asMap = (value: string | VdfMap | undefined): VdfMap => (typeof value === 'object' ? value : {});

/** The depots the app manifest of `appId` in the Steam library's `steamapps` folder records as installed, each with the ID Steam
 *  gives its version; none when Steam holds no app manifest for it. */
export async function installedDepots(steamapps: string, appId: string): Promise<SteamDepot[]> {
  const text = await readOrAbsent(() => readFile(join(steamapps, `appmanifest_${appId}.acf`), 'utf-8'), '');
  const tokens = [...text.matchAll(TOKEN)].map((match) => match[1] ?? match[2] ?? '');
  const depots = asMap(asMap(parseMap(tokens, 0).map.AppState).InstalledDepots);
  return Object.entries(depots).flatMap(([id, depot]) => {
    const version = asMap(depot).manifest;
    return typeof version === 'string' ? [{ id, version }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
