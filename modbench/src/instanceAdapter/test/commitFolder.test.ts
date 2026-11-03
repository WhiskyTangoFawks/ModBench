import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitFolder } from '../commitFolder';

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function put(file: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), 'x');
}

const LINES =(list: string): string => `${list}!/mods/*\n`;

describe('commitFolder', () => {
  it('commits the files of the folder alone, whatever else is staged or changed', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-commit-folder-'));
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    await put('mods/Mod [A]/a.esp');
    await put('mods/Mod [A]/textures/b.dds');
    await put('mods/ModB/b.esp');
    await put('profiles/Default/modlist.txt');
    git('add', 'profiles');

    await commitFolder(root, join(root, 'mods', 'Mod [A]'), 'Init Mod [A]', LINES);

    expect([git('log', '--format=%s'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain').split('\n').sort()]).toEqual([
      'Init Mod [A]', ['mods/Mod [A]/a.esp', 'mods/Mod [A]/textures/b.dds'], ['?? mods/ModB/', 'A  profiles/Default/modlist.txt'],
    ]);
  });

  it('commits the lines that let the folder in, and no other change to the ignore list', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-commit-folder-'));
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    await writeFile(join(root, '.gitignore'), '/mods/*/*\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'Base');
    await put('mods/ModA/a.esp');
    await writeFile(join(root, '.gitignore'), '/mods/*/*\n/mine\n!/mods/ModA/*\n');

    await commitFolder(root, join(root, 'mods', 'ModA'), 'Init ModA', (list) => `${list}!/mods/ModA/*\n`);

    expect([git('show', 'HEAD:.gitignore'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain')]).toEqual([
      '/mods/*/*\n!/mods/ModA/*', ['.gitignore', 'mods/ModA/a.esp'], 'M .gitignore',
    ]);
  });

  it('rejects, committing nothing, when git has nothing of the folder to commit', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-commit-folder-'));
    git('init', '-q');
    await mkdir(join(root, 'mods', 'Empty'), { recursive: true });

    await expect(commitFolder(root, join(root, 'mods', 'Empty'), 'Init Empty', LINES)).rejects.toThrow();
  });
});
