import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { foldersHeldWhole } from '../foldersHeldWhole';

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function instanceIgnoring(ignoreList: string, files: readonly string[]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'modbench-held-whole-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, '.gitignore'), ignoreList);
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), 'x');
  }
}

const WHITELIST = '/*\n!/.gitignore\n!/mods/\n/mods/*\n!/mods/*/\n/mods/*/*\n!/mods/*/*.manifest.json\n';
const FILES = ['mods/Held/a.esp', 'mods/Held/meta.ini', 'mods/Held/textures/b.dds', 'mods/Kept/a.esp', 'mods/Kept/meta.ini'];

describe('the folders git holds whole', () => {
  it('names a folder the ignore list lets in by hand and not one it leaves out', async () => {
    await instanceIgnoring(`${WHITELIST}!/mods/Held/**\n`, FILES);
    const held = await foldersHeldWhole(root, [join(root, 'mods/Held'), join(root, 'mods/Kept')]);
    expect([...held]).toEqual([join(root, 'mods/Held')]);
  });

  it('reads a folder as not held when only its subfolder is ignored', async () => {
    await instanceIgnoring(`${WHITELIST}!/mods/Held/**\n/mods/Held/textures/\n`, FILES);
    expect([...await foldersHeldWhole(root, [join(root, 'mods/Held')])]).toEqual([]);
  });

  it('reads a folder git tracks as held although the ignore list would leave it out', async () => {
    await instanceIgnoring(WHITELIST, FILES);
    execFileSync('git', ['add', '-f', 'mods/Kept'], { cwd: root });
    expect([...await foldersHeldWhole(root, [join(root, 'mods/Kept')])]).toEqual([join(root, 'mods/Kept')]);
  });

  it('reads a folder git tracks in part as not held, since the rest of it is left out', async () => {
    await instanceIgnoring(WHITELIST, FILES);
    execFileSync('git', ['add', '-f', 'mods/Kept/a.esp'], { cwd: root });
    expect([...await foldersHeldWhole(root, [join(root, 'mods/Kept')])]).toEqual([]);
  });

  it('holds none while the instance holds no repository', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-held-whole-'));
    expect([...await foldersHeldWhole(root, [join(root, 'mods/Held')])]).toEqual([]);
  });

  it('rejects when git cannot list the instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-held-whole-'));
    await mkdir(join(root, '.git'));
    await expect(foldersHeldWhole(root, [join(root, 'mods/Held')])).rejects.toThrow();
  });
});
