// How MO2 learns what Nexus knows of a downloaded file (downloadmanager.cpp): by its MD5 over the game's names, and by the mod's page and file list when the MD5 does not settle it.

import type { NexusFileInfo } from '../ports/nexusFileInfo';

const REMOVED = 6;
const ARCHIVED = 7;
export const NOT_READ = 'Nexus answered in a form Modbench does not read.';
const NOT_KNOWN = 'Nexus does not know this file.';

export type Read = (path: string, notFound?: string) => Promise<{ json: unknown } | { reason: string }>;
export type FileFound = { found: true; info: NexusFileInfo } | { found: false; reason: string };

type Fields = Record<string, unknown>;
interface Hit {
  readonly mod: Fields & { mod_id: number };
  readonly file_details: Fields & { file_id: number };
}

const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const isHit = (value: unknown): value is Hit =>
  isRecord(value) && isRecord(value.mod) && typeof value.mod.mod_id === 'number' && isRecord(value.file_details) && typeof value.file_details.file_id === 'number';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// QTextDocument::setHtml(...).toPlainText() for the markup a mod's name holds.
const plainTextOf = (html: string): string =>
  html.trim().replace(/<[^>]*>/g, '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, decimal?: string, hex?: string, name?: string) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[(name ?? '').toLowerCase()] ?? whole;
  });

const modFieldsOf = (mod: Fields): Partial<NexusFileInfo> => ({
  modName: text(mod.name), category: number(mod.category_id), author: text(mod.author), uploader: text(mod.uploaded_by), uploaderUrl: text(mod.uploaded_users_profile_url),
});

const fileFieldsOf = (file: Fields): Partial<NexusFileInfo> => ({
  name: text(file.name), version: text(file.version), modVersion: text(file.mod_version), fileCategory: number(file.category_id), description: text(file.description),
});

const overlay = <T extends object>(base: T, top: Partial<T>): T =>
  ({ ...base, ...Object.fromEntries(Object.entries(top).filter(([, value]) => value !== undefined)) });

const only = <T>(items: readonly T[]): T | undefined => (items.length === 1 ? items[0] : undefined);
const isActive = ({ file_details }: Hit): boolean => file_details.category_id !== REMOVED && file_details.category_id !== ARCHIVED;

// nxmFileInfoFromMd5Available: the lone hit, else the lone hit that bears the file's name, else the lone active one.
function chosenHit(hits: readonly Hit[], fileName: string): Hit | undefined {
  if (hits.length <= 1) return hits[0];
  const named = hits.filter(({ file_details }) => typeof file_details.file_name === 'string' && file_details.file_name.toLowerCase() === fileName.toLowerCase());
  return only(named) ?? only(hits.filter(isActive));
}

// nxmFilesAvailable: a listed file bears the name when it, or its spaces as underscores, is a name the downloaded file goes by.
function listedFile(json: unknown, names: readonly string[]): Fields | undefined {
  const files = isRecord(json) && Array.isArray(json.files) ? json.files : [];
  return files.find((file): file is Fields => {
    const listed = isRecord(file) ? file.file_name : undefined;
    return typeof listed === 'string' && (names.includes(listed) || names.includes(listed.replaceAll(' ', '_')));
  });
}

const namesOf = (fileName: string, ...remote: (string | undefined)[]): string[] =>
  [...remote.flatMap((name) => name ?? []), fileName, fileName.replace(/^\d_/, '')];

const fileOwnerOf = (file: Fields): Partial<NexusFileInfo> => ({ author: text(file.author), uploader: text(file.uploaded_by), uploaderUrl: text(file.uploaded_users_profile_url) });

function fromListedFile(info: NexusFileInfo, file: Fields): NexusFileInfo {
  return overlay(info, { ...fileFieldsOf(file), ...fileOwnerOf(file), ...(typeof file.file_id === 'number' ? { fileID: String(file.file_id) } : {}) });
}

// A hit that lacks the file's description has it from the mod's file list.
async function withDescription(read: Read, fileName: string, game: string, hit: Hit, info: NexusFileInfo): Promise<NexusFileInfo> {
  if ('description' in hit.file_details) return info;
  const listed = await read(`/v1/games/${game}/mods/${hit.mod.mod_id}/files.json`);
  if ('reason' in listed) return info;
  const file = listedFile(listed.json, namesOf(fileName, text(hit.file_details.file_name)));
  return file === undefined ? info : fromListedFile(info, file);
}

/** The file by its MD5, asking each game in turn; the first that holds it settles it. */
export async function lookupByMd5(read: Read, { games, md5, fileName }: { games: readonly string[]; md5: string; fileName: string }): Promise<FileFound> {
  let reason = NOT_KNOWN;
  for (const game of games) {
    const searched = await read(`/v1/games/${game}/mods/md5_search/${md5}.json`, NOT_KNOWN);
    if ('reason' in searched) { reason = searched.reason; continue; }
    const hits = Array.isArray(searched.json) ? searched.json : undefined;
    if (hits === undefined || !hits.every(isHit)) { reason = NOT_READ; continue; }
    if (hits.length === 0) { reason = NOT_KNOWN; continue; }
    const hit = chosenHit(hits, fileName);
    if (hit === undefined) return { found: false, reason: 'Nexus holds several files with this MD5, and none is the one named so.' };
    const base: NexusFileInfo = { game, modID: String(hit.mod.mod_id), fileID: String(hit.file_details.file_id) };
    const info = overlay(base, { ...fileFieldsOf(hit.file_details), ...modFieldsOf(hit.mod) });
    return { found: true, info: await withDescription(read, fileName, game, hit, info) };
  }
  return { found: false, reason };
}

/** The file by the mod's page and file list; a file whose ID is known needs the page only. */
export async function lookupByName(read: Read, { game, modID, fileID, fileName }: { game: string; modID: string; fileID?: string; fileName: string }): Promise<FileFound> {
  const mod = `/v1/games/${game}/mods/${modID}`;
  const page = await read(`${mod}.json`);
  if ('reason' in page) return { found: false, ...page };
  if (!isRecord(page.json)) return { found: false, reason: NOT_READ };
  const name = text(page.json.name);
  const modFields = { ...modFieldsOf(page.json), modName: name === undefined ? undefined : plainTextOf(name) };
  if (fileID !== undefined) return { found: true, info: overlay<NexusFileInfo>({ game, modID, fileID }, modFields) };
  const listed = await read(`${mod}/files.json`);
  if ('reason' in listed) return { found: false, ...listed };
  const file = listedFile(listed.json, namesOf(fileName));
  if (file === undefined) return { found: false, reason: 'no file on Nexus bears the downloaded file\'s name' };
  if (typeof file.file_id !== 'number') return { found: false, reason: NOT_READ };
  return { found: true, info: fromListedFile(overlay<NexusFileInfo>({ game, modID, fileID: String(file.file_id) }, modFields), file) };
}
