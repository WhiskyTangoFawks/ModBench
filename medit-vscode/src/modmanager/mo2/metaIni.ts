// Read-only parse of a mod's meta.ini [General] section. 2.1 never writes meta.ini.

export interface ModMeta {
  version?: string;
  nexusId?: string;
  archiveFilename?: string;
}

export function parseMetaIni(text: string): ModMeta {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const value = raw.slice(eq + 1).trim();
    if (value) values.set(raw.slice(0, eq).trim(), value); // blank == absent
  }
  const modid = values.get('modid');
  return {
    version: values.get('version'),
    nexusId: modid && modid !== '0' ? modid : undefined,
    archiveFilename: values.get('installationFile'),
  };
}
