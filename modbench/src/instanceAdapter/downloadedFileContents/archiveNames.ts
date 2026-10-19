/** The archive extensions install can extract. Every picker and the downloads listing read
 *  this list, compared case-insensitively. */
export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar'] as const;

const archiveExtensionPattern = new RegExp(String.raw`\.(${ARCHIVE_EXTENSIONS.join('|')})$`, 'i');

/** Whether install can extract a file of this name. */
export function isArchiveName(name: string): boolean {
  return archiveExtensionPattern.test(name);
}
