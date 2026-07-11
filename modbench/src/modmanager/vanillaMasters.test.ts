import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVanillaMasters } from './vanillaMasters';

describe('readVanillaMasters', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('lists lowercased .esm and .esp basenames from the resolved Data folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), '');
    await writeFile(join(dataFolder, 'DLCRobot.esm'), '');
    await writeFile(join(dataFolder, 'NotAMaster.esp'), '');

    const masters = await readVanillaMasters(dataFolder);
    expect(masters).toEqual(new Set(['fallout4.esm', 'dlcrobot.esm', 'notamaster.esp']));
  });

  it('includes .esl (Creation Club) and .esp plugins alongside .esm masters', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await writeFile(join(dataFolder, 'Fallout4.esm'), '');
    await writeFile(join(dataFolder, 'ccBGSFO4044-HellfirePowerArmor.esl'), '');
    await writeFile(join(dataFolder, 'Update.esp'), '');
    await writeFile(join(dataFolder, 'readme.txt'), '');

    const masters = await readVanillaMasters(dataFolder);
    expect(masters).toEqual(
      new Set(['fallout4.esm', 'ccbgsfo4044-hellfirepowerarmor.esl', 'update.esp']),
    );
  });

  it('returns an empty set (no fs access) when no Data folder was resolved', async () => {
    expect(await readVanillaMasters(undefined)).toEqual(new Set());
  });

  it('tolerates an unreachable Data folder and returns an empty set', async () => {
    expect(await readVanillaMasters('/no/such/game/path/Data')).toEqual(new Set());
  });

  it('logs the failure reason when falling back to an empty set', async () => {
    const logs: string[] = [];
    await readVanillaMasters('/no/such/game/path/Data', (m) => logs.push(m));
    expect(logs.length).toBeGreaterThan(0);
  });
});
