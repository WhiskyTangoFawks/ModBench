// mods/ and the game dir are siblings inside ONE mkdtemp root, so the deployer's
// same-volume check cannot false-fail when /tmp is a separate mount.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GameDirectory } from '../gameDirectory';
import { FileConflictLookup, type FileConflictIndex } from '../fileConflictIndex';

export interface DeployerFixture {
  instanceRoot: string;
  gameDirectory: GameDirectory;
  writeModFile(mod: string, relativePath: string, content?: string): Promise<string>;
  /** Writes into the game's Data/ directly, standing in for a vanilla file. */
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

export function makeIndex(files: Record<string, string>): FileConflictIndex {
  const lookup = new FileConflictLookup();
  for (const [relativePath, winner] of Object.entries(files)) {
    lookup.set({ relativePath, winner, winnerMod: 'test', providers: ['test'] });
  }
  return { files: lookup, filesByMod: new Map() };
}
