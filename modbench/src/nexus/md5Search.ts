import type { NexusFileInfo } from '../ports/nexusFileInfo';

const REMOVED = 6;
const ARCHIVED = 7;

interface Hit {
  readonly mod: Record<string, unknown> & { mod_id: number };
  readonly file_details: Record<string, unknown> & { file_id: number; file_name?: unknown; category_id?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isHit = (value: unknown): value is Hit =>
  isRecord(value) && isRecord(value.mod) && typeof value.mod.mod_id === 'number' && isRecord(value.file_details) && typeof value.file_details.file_id === 'number';

/** The hits of an MD5 search, or undefined when the answer is not one. */
export const hitsOf = (json: unknown): Hit[] | undefined => (Array.isArray(json) && json.every(isHit) ? json : undefined);

const only = <T>(items: readonly T[]): T | undefined => (items.length === 1 ? items[0] : undefined);
const isActive = ({ file_details }: Hit): boolean => file_details.category_id !== REMOVED && file_details.category_id !== ARCHIVED;

// MO2's choice (downloadmanager.cpp nxmFileInfoFromMd5Available): the lone hit, else the lone hit that bears the file's name, else the lone active one.
export function chosenHit(hits: readonly Hit[], fileName: string): Hit | undefined {
  if (hits.length <= 1) return hits[0];
  const named = hits.filter(({ file_details }) => typeof file_details.file_name === 'string' && file_details.file_name.toLowerCase() === fileName.toLowerCase());
  return only(named) ?? only(hits.filter(isActive));
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const named = <T extends object>(fields: { [K in keyof T]: T[K] | undefined }): Partial<T> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

export function infoOf(game: string, { mod, file_details: file }: Hit): NexusFileInfo {
  return {
    game, modID: String(mod.mod_id), fileID: String(file.file_id),
    ...named<Omit<NexusFileInfo, 'game' | 'modID' | 'fileID'>>({
      name: text(file.name),
      version: text(file.version) ?? text(file.mod_version),
      fileCategory: number(file.category_id),
      modName: text(mod.name),
      category: number(mod.category_id),
      author: text(mod.author),
      uploader: text(mod.uploaded_by),
      uploaderUrl: text(mod.uploaded_users_profile_url),
    }),
  };
}
