// Parse/serialize a mod's meta.ini [General] section.

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

/** Serialize a mod's meta.ini [General] section, emitting only the keys present.
 *  Keys use MO2's names so the result round-trips through parseMetaIni. */
export function writeMetaIni(meta: {
  gameName?: string;
  modid?: string;
  version?: string;
  installationFile?: string;
}): string {
  const lines = ['[General]'];
  for (const key of ['gameName', 'modid', 'version', 'installationFile'] as const) {
    const value = meta[key];
    if (value) lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n';
}
