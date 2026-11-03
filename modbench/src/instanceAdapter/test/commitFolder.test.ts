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

async function put(file: string, text = 'x'): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

async function repository(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'modbench-commit-folder-'));
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
}

async function committedIgnoreList(text: string): Promise<void> {
  await put('.gitignore', text);
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'Base');
}

const neverCalled = (): string => { throw new Error('no committed ignore list to add lines to'); };

describe('commitFolder', () => {
  it('commits the files of the folder alone, whatever else is staged or changed', async () => {
    await repository();
    await put('mods/Mod [A]/a.esp');
    await put('mods/Mod [A]/textures/b.dds');
    await put('mods/ModB/b.esp');
    await put('profiles/Default/modlist.txt');
    git('add', 'profiles');

    await commitFolder(root, join(root, 'mods', 'Mod [A]'), 'Init Mod [A]', neverCalled);

    expect([git('log', '--format=%s'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain').split('\n').sort()]).toEqual([
      'Init Mod [A]', ['mods/Mod [A]/a.esp', 'mods/Mod [A]/textures/b.dds'], ['?? mods/ModB/', 'A  profiles/Default/modlist.txt'],
    ]);
  });

  it('commits the lines that let the folder in, and no other change to the ignore list', async () => {
    await repository();
    await committedIgnoreList('/mods/*/*\n');
    await put('mods/ModA/a.esp');
    await put('.gitignore', '/mods/*/*\n/mine\n!/mods/ModA/*\n');

    await commitFolder(root, join(root, 'mods', 'ModA'), 'Init ModA', (list) => `${list}!/mods/ModA/*\n`);

    expect([git('show', 'HEAD:.gitignore'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain')]).toEqual([
      '/mods/*/*\n!/mods/ModA/*', ['.gitignore', 'mods/ModA/a.esp'], 'M .gitignore',
    ]);
  });

  it('commits the ignore list whole when no commit holds one, so the commit leaves out what the list leaves out', async () => {
    await repository();
    await put('mods/ModA/a.esp');
    await put('.gitignore', '/mods/*/*\n!/mods/ModA/*\n');

    await commitFolder(root, join(root, 'mods', 'ModA'), 'Init ModA', neverCalled);

    expect([git('show', 'HEAD:.gitignore'), git('status', '--porcelain')]).toEqual(['/mods/*/*\n!/mods/ModA/*', '']);
  });

  it('rejects, committing nothing, when the lines cannot be added to the ignore list as committed', async () => {
    await repository();
    await committedIgnoreList('/mods/*/*\n');
    await put('mods/ModA/a.esp');
    await put('.gitignore', '/mods/*/*\n!/mods/ModA/*\n');

    await expect(commitFolder(root, join(root, 'mods', 'ModA'), 'Init ModA', () => { throw new Error('its markers do not pair'); })).rejects.toThrow('its markers do not pair');
    expect(git('log', '--format=%s')).toBe('Base');
  });

  it('rejects, committing nothing, when git has nothing of the folder to commit', async () => {
    await repository();
    await mkdir(join(root, 'mods', 'Empty'), { recursive: true });

    await expect(commitFolder(root, join(root, 'mods', 'Empty'), 'Init Empty', neverCalled)).rejects.toThrow();
  });
});
