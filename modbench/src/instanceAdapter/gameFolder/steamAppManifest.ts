import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOrAbsent, readOrReason } from '../files';

/** A store depot the game's install records, by its id, and the ID Steam gives the version installed. */
export interface Depot {
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

/** The depots Steam records as installed, each with the ID Steam gives its version, and why the app manifest gave less than that. */
export interface InstalledDepots {
  readonly depots: Depot[];
  readonly problems: string[];
}

/** The depots the app manifest of `appId` in the Steam library's `steamapps` folder records as installed; none, and no problem,
 *  when Steam holds no app manifest for it. */
export async function installedDepots(steamapps: string, appId: string): Promise<InstalledDepots> {
  const file = `appmanifest_${appId}.acf`;
  const read = await readOrReason(() => readOrAbsent(() => readFile(join(steamapps, file), 'utf-8'), undefined));
  if (read.kind === 'unreadable') return { depots: [], problems: [`${file} could not be read: ${read.reason}`] };
  const text = read.answer;
  if (text === undefined) return { depots: [], problems: [] };
  const tokens = [...text.matchAll(TOKEN)].map((match) => match[1] ?? match[2] ?? '');
  const appState = asMap(parseMap(tokens, 0).map.AppState);
  if (Object.keys(appState).length === 0) return { depots: [], problems: [`${file} is not an app manifest Modbench reads`] };
  const recorded = Object.entries(asMap(appState.InstalledDepots));
  if (recorded.length === 0) return { depots: [], problems: [`${file} records no installed depot`] };
  const depots: Depot[] = [];
  const problems: string[] = [];
  for (const [id, depot] of recorded) {
    const version = asMap(depot).manifest;
    if (typeof version === 'string') depots.push({ id, version });
    else problems.push(`${file} records no version of depot ${id}`);
  }
  return { depots: depots.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })), problems };
}
