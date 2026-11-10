import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
const FILES = ['mods/Cloned/Cloned.manifest.json', 'mods/Held/a.esp', 'mods/Held/meta.ini', 'mods/Held/textures/b.dds', 'mods/Kept/a.esp', 'mods/Kept/meta.ini'];
const LETS_IN_HELD = '!/mods/Held/**\n';

describe('the folders git holds whole', () => {
  it.each([
    ['a folder the ignore list lets in with one line for the folder', true, LETS_IN_HELD, [], 'mods/Held'],
    ['a folder the ignore list leaves out', false, LETS_IN_HELD, [], 'mods/Kept'],
    ['a folder let in with git\'s own line for its files', true, '!/mods/Held/*\n', [], 'mods/Held'],
    ['a folder let in whose subfolder is ignored', false, `${LETS_IN_HELD}/mods/Held/textures/\n`, [], 'mods/Held'],
    ['a folder let in by a pattern that matches its name', true, '!mods/Held*/**\n', [], 'mods/Held'],
    ['a folder let in whose new subfolders are ignored, none on disk', false, '!/mods/Cloned/*\n/mods/Cloned/*/\n', [], 'mods/Cloned'],
    ['a folder holding only its manifest, untracked', false, '', [], 'mods/Cloned'],
    ['a folder holding only its manifest, tracked as a clone leaves it', false, '', ['add', 'mods/Cloned'], 'mods/Cloned'],
    ['a folder git tracks though the ignore list would leave out a new file', false, '', ['add', '-f', 'mods/Kept'], 'mods/Kept'],
    ['a folder outside the instance', false, LETS_IN_HELD, [], '../elsewhere'],
  ])('reads %s, held: %s', async (_case, held, ignoreList, git, folder) => {
    await instanceIgnoring(`${WHITELIST}${ignoreList}`, FILES);
    if (git.length > 0) execFileSync('git', git, { cwd: root });

    expect([...await foldersHeldWhole(root, [join(root, folder)], [])]).toEqual(held ? [join(root, folder)] : []);
  });

  it('answers each folder of a batch by itself', async () => {
    await instanceIgnoring(`${WHITELIST}${LETS_IN_HELD}`, FILES);

    expect([...await foldersHeldWhole(root, [join(root, 'mods/Held'), join(root, 'mods/Kept')], [])]).toEqual([join(root, 'mods/Held')]);
  });

  it.each([
    ['a mod folder that is a symlink', 'mods/Linked'],
    ['a folder below a symlinked mods folder', 'linked-mods/Held'],
  ])('holds %s as not whole and still answers the others', async (_case, linked) => {
    await instanceIgnoring(`${WHITELIST}${LETS_IN_HELD}`, FILES);
    const target = join(root, 'elsewhere');
    await mkdir(join(target, 'Held'), { recursive: true });
    await symlink(target, join(root, linked.startsWith('mods/') ? linked : 'linked-mods'));

    expect([...await foldersHeldWhole(root, [join(root, linked), join(root, 'mods/Held')], [])]).toEqual([join(root, 'mods/Held')]);
  });

  it('holds none while the instance holds no repository',async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-held-whole-'));
    expect([...await foldersHeldWhole(root, [join(root, 'mods/Held')], [])]).toEqual([]);
  });

  it('rejects when git cannot list the instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-held-whole-'));
    await mkdir(join(root, '.git'));
    await expect(foldersHeldWhole(root, [join(root, 'mods/Held')], [])).rejects.toThrow();
  });
});
