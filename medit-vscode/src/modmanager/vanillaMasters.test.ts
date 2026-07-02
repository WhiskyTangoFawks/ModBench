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

  it('lists lowercased .esm basenames from <gamePath>/Data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const gamePath = join(dir, 'Game');
    await mkdir(join(gamePath, 'Data'), { recursive: true });
    await writeFile(join(gamePath, 'Data', 'Fallout4.esm'), '');
    await writeFile(join(gamePath, 'Data', 'DLCRobot.esm'), '');
    await writeFile(join(gamePath, 'Data', 'NotAMaster.esp'), '');
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\ngamePath=@ByteArray(${gamePath})\r\n`,
    );

    const masters = await readVanillaMasters(dir);
    expect(masters).toEqual(new Set(['fallout4.esm', 'dlcrobot.esm']));
  });

  it('tolerates a missing ModOrganizer.ini and returns an empty set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    expect(await readVanillaMasters(dir)).toEqual(new Set());
  });

  it('tolerates an unreachable gamePath and returns an empty set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      '[General]\r\ngamePath=@ByteArray(/no/such/game/path)\r\n',
    );
    expect(await readVanillaMasters(dir)).toEqual(new Set());
  });

  it('logs the failure reason when falling back to an empty set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-vanillamasters-'));
    const logs: string[] = [];
    await readVanillaMasters(dir, (m) => logs.push(m));
    expect(logs.length).toBeGreaterThan(0);
  });
});
