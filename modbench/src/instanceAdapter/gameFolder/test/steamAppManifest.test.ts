import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Depot } from '../../instanceAdapter';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { instanceOnDisk } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

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

describe('the depots Steam records as installed of the game where it is', () => {
  let library: string;
  let steamapps: string;
  let instance: string;

  beforeEach(async () => {
    library = await mkdtemp(join(tmpdir(), 'steamapps-'));
    steamapps = join(library, 'steamapps');
    await mkdir(join(steamapps, 'common', 'Fallout 4', 'Data'), { recursive: true });
    instance = await instanceOnDisk();
  });
  afterEach(async () => {
    await rm(library, { recursive: true, force: true });
    await rm(instance, { recursive: true, force: true });
  });

  const installedDepots = async () => {
    const root = join(steamapps, 'common', 'Fallout 4');
    const place = await adapterOver(instance, { gameFolderSettingValue: root, detectors: { ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: join(root, 'Data') }) } }).gamePlace();
    return { depots: place?.depots, problems: place?.depotProblems };
  };

  it('are each installed depot with the ID Steam gives its version, in the order of the depot IDs', async () => {
    await writeFile(join(steamapps, 'appmanifest_377160.acf'), APP_MANIFEST);

    expect(await installedDepots()).toEqual({
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

    expect(await installedDepots()).toEqual({ depots, problems });
  });
});
