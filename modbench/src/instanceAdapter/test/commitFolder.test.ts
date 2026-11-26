import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { diskCheckedBy } from '../../repositoriesLib/writesTold';
import type { InstanceAdapter } from '../instanceAdapter';

vi.mock('vscode', () => fakeVscodeModule());

let root: string;

afterEach(async () => {
  diskCheckedBy({ name: () => undefined, leaveUnnamed: () => undefined, settling: () => undefined });
  await rm(root, { recursive: true, force: true });
});

const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function put(file: string, text = 'x'): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

async function repository(): Promise<InstanceAdapter> {
  root = await mkdtemp(join(tmpdir(), 'modbench-commit-folder-'));
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  return adapterOver(root);
}

async function committedIgnoreList(text: string): Promise<void> {
  await put('.gitignore', text);
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'Base');
}

const HELD_WHOLE = '# Mod folders this repository holds whole\n!/mods/ModA/*\n/mods/ModA/meta.ini\n# End of mod folders this repository holds whole';

describe('a mod folder committed', () => {
  it('names .git, and nothing else, as what it writes, so a reading after it reads the repository again', async () => {
    const adapter = await repository();
    await committedIgnoreList('');
    await put('mods/Mod [A]/a.esp');
    const named: string[] = [];
    diskCheckedBy({ name: (paths) => { named.push(...paths); }, leaveUnnamed: () => { throw new Error('a write left its files unnamed'); }, settling: () => undefined });

    await adapter.commitFolder(join(root, 'mods', 'Mod [A]'), 'Init');

    expect([...new Set(named)]).toEqual([join(root, '.git')]);
  });

  it('commits the files of the folder alone, whatever else is staged or changed', async () => {
    const adapter = await repository();
    await put('mods/Mod [A]/a.esp');
    await put('mods/Mod [A]/textures/b.dds');
    await put('mods/ModB/b.esp');
    await put('profiles/Default/modlist.txt');
    git('add', 'profiles');

    await adapter.commitFolder(join(root, 'mods', 'Mod [A]'), 'Init Mod [A]');

    expect([git('log', '--format=%s'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain').split('\n').sort()]).toEqual([
      'Init Mod [A]', ['mods/Mod [A]/a.esp', 'mods/Mod [A]/textures/b.dds'], ['?? mods/ModB/', 'A  profiles/Default/modlist.txt'],
    ]);
  });

  it('commits the lines that let the folder in, and no other change to the ignore list', async () => {
    const adapter = await repository();
    await committedIgnoreList('/mods/*/*\n');
    await put('mods/ModA/a.esp');
    await put('.gitignore', `/mods/*/*\n/mine\n${HELD_WHOLE}\n`);

    await adapter.commitFolder(join(root, 'mods', 'ModA'), 'Init ModA');

    expect([git('show', 'HEAD:.gitignore'), git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), git('status', '--porcelain')]).toEqual([
      `/mods/*/*\n${HELD_WHOLE}`, ['.gitignore', 'mods/ModA/a.esp'], 'M .gitignore',
    ]);
  });

  it('commits only the lines that let the folder in when no commit holds an ignore list, leaving the rest of it uncommitted', async () => {
    const adapter = await repository();
    await put('mods/ModA/a.esp');
    await put('.gitignore', `/mods/*/*\n${HELD_WHOLE}\n`);

    await adapter.commitFolder(join(root, 'mods', 'ModA'), 'Init ModA');

    expect([git('show', 'HEAD:.gitignore'), git('status', '--porcelain')]).toEqual([HELD_WHOLE, 'M .gitignore']);
  });

  it('rejects, committing nothing, when git has nothing of the folder to commit', async () => {
    const adapter = await repository();
    await mkdir(join(root, 'mods', 'Empty'), { recursive: true });

    await expect(adapter.commitFolder(join(root, 'mods', 'Empty'), 'Init Empty')).rejects.toThrow();
  });
});
