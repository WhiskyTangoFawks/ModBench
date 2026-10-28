import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INSTALLED_DEPOT = { id: '377162', version: '2222' };

export const writeAppManifestOfDepot = (library: string): Promise<void> =>
  writeFile(join(library, 'steamapps', 'appmanifest_377160.acf'), `"AppState"\n{\n"InstalledDepots"\n{\n"${INSTALLED_DEPOT.id}"\n{\n"manifest" "${INSTALLED_DEPOT.version}"\n}\n}\n}\n`);
