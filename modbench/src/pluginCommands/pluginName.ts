import { NOT_A_FOLDER_NAME } from '../coreLib/folderName';
import { isBareName } from '../instanceAdapter/instanceAdapter';
import { fileExtension } from '../tables/pluginFile';

const listed = new Intl.ListFormat('en-US', { type: 'disjunction' });

/** Why a plugin name is refused whatever place holds it, or undefined (plugins.md, Create plugin,
 *  story 1). */
export function pluginNameRefusal(name: string, creatableExtensions: readonly string[]): string | undefined {
  if (!name) return 'Name is required';
  if (!isBareName(name)) return NOT_A_FOLDER_NAME;
  if (!creatableExtensions.includes(fileExtension(name))) return `Extension must be ${listed.format(creatableExtensions)}`;
  return undefined;
}
