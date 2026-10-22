interface NexusFileEntry { file_id: number; version: string; category_id: number; file_name: string }
interface NexusFileUpdate { old_file_id: number; new_file_id: number; old_file_name?: string; new_file_name?: string }
export interface FileList { files: NexusFileEntry[]; file_updates: NexusFileUpdate[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isEntry = (value: unknown): value is NexusFileEntry => isRecord(value) && typeof value.file_id === 'number' && typeof value.version === 'string'
  && typeof value.category_id === 'number' && typeof value.file_name === 'string';
const isUpdate = (value: unknown): value is NexusFileUpdate => isRecord(value) && typeof value.old_file_id === 'number' && typeof value.new_file_id === 'number';

/** The file list Nexus answers, or undefined when the answer is not one. */
export function fileListOf(json: unknown): FileList | undefined {
  if (!isRecord(json) || !Array.isArray(json.files) || !Array.isArray(json.file_updates)) return undefined;
  const { files, file_updates } = json;
  return files.every(isEntry) && file_updates.every(isUpdate) ? { files, file_updates } : undefined;
}

export interface InstalledFile {
  readonly fileId?: string;
  readonly fileName?: string;
}

const ACTIVE = new Set([1, 2, 3, 5]);
const REMOVED = 6;
const ARCHIVED_HIDDEN = 1000;
const sameName = (a: string, b: string | undefined): boolean => b !== undefined && a.toLowerCase() === b.toLowerCase();

function installedFileId({ files, file_updates }: FileList, { fileId, fileName }: InstalledFile): number | undefined {
  if (fileId !== undefined && Number.isInteger(Number(fileId))) return Number(fileId);
  if (fileName === undefined) return undefined;
  const listed = files.find((file) => sameName(fileName, file.file_name));
  if (listed) return listed.file_id;
  for (const update of file_updates) {
    if (sameName(fileName, update.old_file_name)) return update.old_file_id;
    if (sameName(fileName, update.new_file_name)) return update.new_file_id;
  }
  return undefined;
}

function successorsOf(start: number, { file_updates }: FileList): number[] {
  const newerBy = new Map(file_updates.map(({ old_file_id, new_file_id }) => [old_file_id, new_file_id]));
  const chain: number[] = [];
  for (let next = newerBy.get(start); next !== undefined && !chain.includes(next); next = newerBy.get(next)) chain.push(next);
  return chain;
}

/** The version of the file an installed file's update chain ends in; undefined when the installed file cannot be told. */
export function newestVersionOf(list: FileList, installed: InstalledFile): string | undefined {
  const start = installedFileId(list, installed);
  if (start === undefined) return undefined;
  const byId = new Map(list.files.map((file) => [file.file_id, file]));
  const successors = successorsOf(start, list).reverse().flatMap((id) => byId.get(id) ?? []);
  const active = successors.find(({ category_id }) => ACTIVE.has(category_id));
  const startIsActive = ACTIVE.has(byId.get(start)?.category_id ?? ARCHIVED_HIDDEN);
  const downloadable = startIsActive ? undefined : successors.find(({ category_id }) => category_id !== REMOVED);
  return (active ?? downloadable ?? byId.get(start))?.version;
}
