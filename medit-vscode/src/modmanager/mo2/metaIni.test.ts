import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMetaIni } from './metaIni';

const modsDir = join(__dirname, '..', 'test', 'fixtures', 'mo2-instance', 'mods');
const meta = (mod: string) => readFileSync(join(modsDir, mod, 'meta.ini'), 'utf8');

describe('parseMetaIni', () => {
  it('reads version, nexusId (modid) and archiveFilename (installationFile)', () => {
    expect(parseMetaIni(meta('Unofficial Fallout 4 Patch'))).toEqual({
      version: '2.1.5.0',
      nexusId: '4598',
      archiveFilename: 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z',
    });
  });

  it('treats modid=0 and empty fields as undefined, not empty strings', () => {
    expect(parseMetaIni(meta('ENBoost - 12k'))).toEqual({
      version: undefined,
      nexusId: undefined,
      archiveFilename: undefined,
    });
  });

  it('returns all-undefined for content missing the keys entirely', () => {
    expect(parseMetaIni('[General]\r\ngameName=Fallout4\r\n')).toEqual({
      version: undefined,
      nexusId: undefined,
      archiveFilename: undefined,
    });
  });
});
