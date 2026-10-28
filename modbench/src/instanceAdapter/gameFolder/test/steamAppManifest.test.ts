import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedDepots } from '../steamAppManifest';

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
    await mkdir(join(steamapps, 'common'));
  });
  afterEach(() => rm(steamapps, { recursive: true, force: true }));

  it('are each installed depot with the ID Steam gives its version, in the order of the depot IDs', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), APP_MANIFEST);

    expect(await installedDepots(steamapps, '377160')).toEqual({
      depots: [{ id: '377161', version: '1111' }, { id: '377162', version: '2222' }], problems: [],
    });
  });

  it('are none, and no problem, when Steam holds no app manifest for the game', async () => {
    expect(await installedDepots(steamapps, '377160')).toEqual({ depots: [], problems: [] });
  });

  it('are none, saying so, when the app manifest records no installed depot', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), '"AppState"\n{\n\t"appid"\t\t"377160"\n}\n');

    expect(await installedDepots(steamapps, '377160')).toEqual({ depots: [], problems: ['appmanifest_377160.acf records no installed depot'] });
  });

  it('are none, saying so, when the file is no app manifest', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), 'garbage {{');

    expect(await installedDepots(steamapps, '377160')).toEqual({ depots: [], problems: ['appmanifest_377160.acf is not an app manifest Modbench reads'] });
  });

  it('leave out a depot that records no version, saying which', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), '"AppState"\n{\n"InstalledDepots"\n{\n"228990"\n{\n"size" "5"\n}\n"377162"\n{\n"manifest" "2"\n}\n}\n}\n');

    expect(await installedDepots(steamapps, '377160')).toEqual({
      depots: [{ id: '377162', version: '2' }], problems: ['appmanifest_377160.acf records no version of depot 228990'],
    });
  });
});
