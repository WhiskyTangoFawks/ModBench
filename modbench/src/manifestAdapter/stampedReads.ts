import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { keptByStamp } from '../repositoriesLib/stampedReads';

/** The entries of a folder, listed again only when its stamp has changed. */
export const entriesByStamp: (folder: string) => Promise<Dirent[]> = keptByStamp((folder) => readdir(folder, { withFileTypes: true }));
