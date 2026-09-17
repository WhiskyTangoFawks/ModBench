// A read-view over the raw MO2 files: these types never own serialization, which stays with
// the byte-faithful text transforms in mo2/.

import type { InstalledFileId } from '../mo2Codecs/metaIni';

export type { InstalledFileId } from '../mo2Codecs/metaIni';
export type { Mod, ModlistEntry, Separator } from '../mo2Codecs/modlistText';
export type { PluginEntry } from '../mo2Codecs/pluginsText';

/** For a manual local install only `installationFile` is typically known; the rest arrives
 *  from a Nexus archive's download identity. */
export interface InstallMeta {
  modid?: string;
  version?: string;
  installationFile?: string;
  installedFiles?: readonly InstalledFileId[];
}
