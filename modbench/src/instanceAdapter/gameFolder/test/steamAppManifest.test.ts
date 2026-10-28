import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedDepots, type Depot } from '../steamAppManifest';

const APP_MANIFEST = `"AppState"
{
\t"appid"\t\t"377160"
\t"name"\t\t"Fallout 4"
\t"InstalledDepots"
\t{
\t\t"377162"
\t\t{
\t\t\t"manifest"\t\t"2222"
\t\t\t"size"\t\t"100"
\t\t}
\t\t"377161"
\t\t{
\t\t\t"manifest"\t\t"1111"
\t\t\t"size"\t\t"7"
\t\t}
\t}
\t"UserConfig"
\t{
\t\t"language"\t\t"english"
\t}
}
`;

describe('the depots Steam records as installed', () => {
  let steamapps: string;

  beforeEach(async () => {
    steamapps = await mkdtemp(join(tmpdir(), 'steamapps-'));
  });
  afterEach(() => rm(steamapps, { recursive: true, force: true }));

  it('are each installed depot with the ID Steam gives its version, in the order of the depot IDs', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), APP_MANIFEST);

    expect(await installedDepots(steamapps, '377160')).toEqual({
      depots: [{ id: '377161', version: '1111' }, { id: '377162', version: '2222' }], problems: [],
    });
  });

  const FILE = 'appmanifest_377160.acf';
  const NO_VERSION = '"AppState"\n{\n"InstalledDepots"\n{\n"228990"\n{\n"size" "5"\n}\n"377162"\n{\n"manifest" "2"\n}\n}\n}\n';

  it.each<[string, (steamapps: string) => Promise<void>, Depot[], unknown[]]>([
    ['are none, and no problem, when Steam holds no app manifest for the game', () => Promise.resolve(), [], []],
    ['are none, saying so, when the app manifest records no installed depot', (dir) => writeFile(join(dir, FILE), '"AppState"\n{\n"appid"\t"1"\n}\n'), [], [`${FILE} records no installed depot`]],
    ['are none, saying so, when the file is no app manifest', (dir) => writeFile(join(dir, FILE), 'garbage {{'), [], [`${FILE} is not an app manifest Modbench reads`]],
    ['leave out a depot that records no version, saying which', (dir) => writeFile(join(dir, FILE), NO_VERSION), [{ id: '377162', version: '2' }], [`${FILE} records no version of depot 228990`]],
    ['are none, saying so, when the file cannot be read', (dir) => mkdir(join(dir, FILE)), [], [expect.stringContaining(`${FILE} could not be read: EISDIR`)]],
  ])('%s', async (_says, setUp, depots, problems) => {
    await setUp(steamapps);

    expect(await installedDepots(steamapps, '377160')).toEqual({ depots, problems });
  });
});
