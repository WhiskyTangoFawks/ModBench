import { folderNameRefusal } from '../coreLib/folderName';
import { fileExtension } from '../tables/pluginFile';

const listed = new Intl.ListFormat('en-US', { type: 'disjunction' });

/** Why a plugin name is refused whatever place holds it, or undefined (plugins.md, Create plugin,
 *  story 1). */
export function pluginNameRefusal(name: string, creatableExtensions: readonly string[]): string | undefined {
  if (!name) return 'Name is required';
  const notAFolder = folderNameRefusal(name);
  if (notAFolder !== undefined) return notAFolder;
  if (!creatableExtensions.includes(fileExtension(name))) return `Extension must be ${listed.format(creatableExtensions)}`;
  return undefined;
}
