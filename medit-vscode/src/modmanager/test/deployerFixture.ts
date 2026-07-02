// Scratch filesystem for Deployer tests. Creates mods/ and a game dir with an
// empty Data/ **as siblings inside one mkdtemp root**, so the deployer's
// same-volume check never false-fails from /tmp being a separate mount than the
// workspace (see modbench-4 test-infra note). Every test registers
// afterEach(fixture.cleanup) so a failing assertion can't leak temp dirs.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GameDirectory } from '../gameDirectory';
import type { ConflictEntry, FileConflictIndex } from '../fileConflictIndex';

export interface DeployerFixture {
  instanceRoot: string;
  gameDirectory: GameDirectory;
  /** Write mods/<mod>/<relativePath>; returns the absolute source path. */
  writeModFile(mod: string, relativePath: string, content?: string): Promise<string>;
  /** Write a file directly into the game's Data/ (a vanilla/foreign file). */
  writeDataFile(relativePath: string, content?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeDeployerFixture(): Promise<DeployerFixture> {
  const instanceRoot = await mkdtemp(join(tmpdir(), 'medit-deploy-'));
  const gameRoot = join(instanceRoot, 'game');
  const dataFolder = join(gameRoot, 'Data');
  await mkdir(dataFolder, { recursive: true });
  await mkdir(join(instanceRoot, 'mods'), { recursive: true });

  const writeUnder = async (base: string, relativePath: string, content: string) => {
    const abs = join(base, relativePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
  };

  return {
    instanceRoot,
    gameDirectory: { root: gameRoot, dataFolder },
    writeModFile: (mod, relativePath, content = relativePath) =>
      writeUnder(join(instanceRoot, 'mods', mod), relativePath, content),
    writeDataFile: (relativePath, content = relativePath) => writeUnder(dataFolder, relativePath, content),
    cleanup: () => rm(instanceRoot, { recursive: true, force: true }),
  };
}

/** Build a FileConflictIndex (the winner map) from relativePath → absolute source. */
export function makeIndex(files: Record<string, string>): FileConflictIndex {
  const map = new Map<string, ConflictEntry>();
  for (const [relativePath, winner] of Object.entries(files)) {
    map.set(relativePath, { winner, winnerMod: 'test', providers: ['test'] });
  }
  return { files: map, filesByMod: new Map() };
}
