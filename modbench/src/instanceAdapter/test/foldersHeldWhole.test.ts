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
const LETS_IN_HELD = '!/mods/Held/**\n';

describe('the folders git holds whole', () => {
  it.each([
    ['a folder the ignore list lets in by hand', true, LETS_IN_HELD, [], 'mods/Held'],
    ['a folder the ignore list leaves out', false, LETS_IN_HELD, [], 'mods/Kept'],
    ['a folder let in whose subfolder is ignored', false, `${LETS_IN_HELD}/mods/Held/textures/\n`, [], 'mods/Held'],
    ['a folder git tracks though the ignore list would leave it out', true, '', ['add', '-f', 'mods/Kept'], 'mods/Kept'],
    ['a folder git tracks in part', false, '', ['add', '-f', 'mods/Kept/a.esp'], 'mods/Kept'],
    ['a folder outside the instance', false, LETS_IN_HELD, [], '../elsewhere'],
  ])('reads %s, held: %s', async (_case, held, ignoreList, git, folder) => {
    await instanceIgnoring(`${WHITELIST}${ignoreList}`, FILES);
    if (git.length > 0) execFileSync('git', git, { cwd: root });

    expect([...await foldersHeldWhole(root, [join(root, folder)])]).toEqual(held ? [join(root, folder)] : []);
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
