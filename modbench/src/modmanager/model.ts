// A read-view over the raw MO2 files: these types never own serialization, which stays with
// the byte-faithful text transforms in mo2/.

export type { InstalledFileId } from '../mo2Codecs/metaIni';
export type { Mod, ModlistEntry, Separator } from '../mo2Codecs/modlistText';
export type { PluginEntry } from '../mo2Codecs/pluginsText';
