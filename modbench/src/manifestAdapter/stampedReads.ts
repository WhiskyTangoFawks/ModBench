import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { keptByStamp as keptByStampOf, stampFrom, type FileStamp } from '../repositoriesLib/stampedReads';

const stampOf = async (path: string): Promise<FileStamp> => stampFrom(await stat(path, { bigint: true }));

/** A reader of `path` that reads it again only when its stamp has changed. */
export const keptByStamp = <T>(read: (path: string) => Promise<T>): (path: string) => Promise<T> => keptByStampOf(stampOf, read);

/** The entries of a folder, listed again only when its stamp has changed. */
export const entriesByStamp: (folder: string) => Promise<Dirent[]> = keptByStamp((folder) => readdir(folder, { withFileTypes: true }));
