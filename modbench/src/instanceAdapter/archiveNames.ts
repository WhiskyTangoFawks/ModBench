import { basename } from 'node:path';

/** The archive extensions install can extract. Every picker and the Downloads view read this
 *  list, compared case-insensitively. */
export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar'] as const;

const archiveExtensionPattern = new RegExp(String.raw`\.(${ARCHIVE_EXTENSIONS.join('|')})$`, 'i');

/** Whether install can extract a file of this name. */
export function isArchiveName(name: string): boolean {
  return archiveExtensionPattern.test(name);
}

/** What a new mod is called before the user says otherwise: the archive's own name, stripped of
 *  the extension install knows how to extract. */
export function defaultModName(archivePath: string): string {
  return basename(archivePath).replace(archiveExtensionPattern, '');
}

/** What a new mod installed from a folder is called before the user says otherwise: the
 *  folder's own name. */
export function defaultModNameForFolder(folder: string): string {
  return basename(folder);
}
