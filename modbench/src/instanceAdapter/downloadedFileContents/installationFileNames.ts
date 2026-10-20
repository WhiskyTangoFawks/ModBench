/** The archive extensions install can extract. Every picker and the downloads listing read
 *  this list, compared case-insensitively. */
export const INSTALLATION_FILE_EXTENSIONS = ['zip', '7z', 'rar'] as const;

const installationFileExtensionPattern = new RegExp(String.raw`\.(${INSTALLATION_FILE_EXTENSIONS.join('|')})$`, 'i');

/** Whether install can extract a file of this name. */
export function isInstallationFileName(name: string): boolean {
  return installationFileExtensionPattern.test(name);
}
