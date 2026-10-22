import { z } from 'zod';

export const FILE_LIST = z.object({
  files: z.array(z.object({ file_id: z.number(), version: z.string(), category_id: z.number(), file_name: z.string() })),
  file_updates: z.array(z.object({
    old_file_id: z.number(),
    new_file_id: z.number(),
    old_file_name: z.string().optional(),
    new_file_name: z.string().optional(),
  })),
});

type FileList = z.infer<typeof FILE_LIST>;

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

/** The version of the file an installed file's update chain ends in, as MO2 walks it; undefined when the installed file cannot be told. */
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
