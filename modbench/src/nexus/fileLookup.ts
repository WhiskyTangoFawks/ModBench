import type { NexusFileInfo } from '../ports/nexusFileInfo';

const REMOVED = 6;
const ARCHIVED = 7;
const NOT_READ = 'Nexus answered in a form Modbench does not read.';
const NOT_KNOWN = 'Nexus does not know this file.';

export type Read = (path: string, notFound?: string) => Promise<{ json: unknown } | { reason: string }>;
/** `notice` says a request for more failed or matched nothing, although the info is written. */
export type FileFound = { found: true; info: NexusFileInfo; notice?: string } | { found: false; reason: string };
type Found = Extract<FileFound, { found: true }>;
const failedRequest = (reason: string): string => `Failed to request file info from Nexus: ${reason}`;
const NO_MATCH = 'No matching file found on Nexus! Maybe this file was removed or renamed?';

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

function chosenHit(hits: readonly Hit[], fileName: string): Hit | undefined {
  if (hits.length <= 1) return hits[0];
  const named = hits.filter(({ file_details }) => typeof file_details.file_name === 'string' && file_details.file_name.toLowerCase() === fileName.toLowerCase());
  return only(named) ?? only(hits.filter(isActive));
}

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
  return overlay(info, { ...fileFieldsOf(file), ...fileOwnerOf(file), fileTime: number(file.uploaded_timestamp), versionFromNewest: true, ...(typeof file.file_id === 'number' ? { fileID: String(file.file_id) } : {}) });
}

async function fromFileList(read: Read, listPath: string, names: readonly string[], info: NexusFileInfo): Promise<Found> {
  const listed = await read(listPath);
  if ('reason' in listed) return { found: true, info, notice: failedRequest(listed.reason) };
  const file = listedFile(listed.json, names);
  return file === undefined ? { found: true, info, notice: NO_MATCH } : { found: true, info: fromListedFile(info, file) };
}

const withDescription = (read: Read, fileName: string, game: string, hit: Hit, info: NexusFileInfo): Promise<Found> | Found =>
  'description' in hit.file_details
    ? { found: true, info }
    : fromFileList(read, `/v1/games/${game}/mods/${hit.mod.mod_id}/files.json`, namesOf(fileName, text(hit.file_details.file_name)), info);

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
    return withDescription(read, fileName, game, hit, info);
  }
  return { found: false, reason };
}

const modPath = (game: string, modID: string): string => `/v1/games/${game}/mods/${modID}`;

async function fromPage(read: Read, { game, modID, fileID }: { game: string; modID: string; fileID?: string }): Promise<FileFound> {
  const page = await read(`${modPath(game, modID)}.json`);
  if ('reason' in page) return { found: false, ...page };
  if (!isRecord(page.json)) return { found: false, reason: NOT_READ };
  const name = text(page.json.name);
  const modFields = { ...modFieldsOf(page.json), modName: name === undefined ? undefined : plainTextOf(name) };
  return { found: true, info: overlay<NexusFileInfo>({ game, modID, fileID }, modFields) };
}

/** The file by the mod's page and file list; a file whose ID is known needs the page only. A file list that fails or names no such file leaves what the page said. */
export async function lookupByName(read: Read, { game, modID, fileID, fileName }: { game: string; modID: string; fileID?: string; fileName: string }): Promise<FileFound> {
  const page = await fromPage(read, { game, modID, fileID });
  if (!page.found || fileID !== undefined) return page;
  return fromFileList(read, `${modPath(game, modID)}/files.json`, namesOf(fileName), page.info);
}

/** The file by its ID, from its own record and its mod's page, as the mod manager takes a file it downloads. */
export async function lookupById(read: Read, { game, modID, fileID }: { game: string; modID: string; fileID: string }): Promise<FileFound> {
  const file = await read(`${modPath(game, modID)}/files/${fileID}.json`, 'Nexus does not hold this file.');
  if ('reason' in file) return { found: false, ...file };
  if (!isRecord(file.json)) return { found: false, reason: NOT_READ };
  const page = await fromPage(read, { game, modID, fileID });
  if (!page.found) return page;
  return { found: true, info: overlay(page.info, { ...fileFieldsOf(file.json), fileTime: number(file.json.uploaded_timestamp), versionFromNewest: true }) };
}
