import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let named: string[];
let unnamed: number;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function put(path: string, text = 'x'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-git-writes-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@t');
  await put('ModOrganizer.ini', '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n');
  await put('mods/Mod A/a.esp');
  await put('source/Mod A/build.json', '{}');
  const source = join(root, 'source', 'Mod A');
  git(source, 'init', '--quiet', '--initial-branch=main');
  git(source, 'remote', 'add', 'origin', 'https://example.test/a.git');
  git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'first');
  named = [];
  unnamed = 0;
});

afterEach(async () => {
  diskCheckedBy({ name: () => undefined, leaveUnnamed: () => undefined, settling: () => undefined });
  await rm(root, { recursive: true, force: true });
});

const listening = (): void => {
  diskCheckedBy({ name: (paths) => { named.push(...paths); }, leaveUnnamed: () => { unnamed++; }, settling: () => undefined });
};

describe('the git a gesture runs names each file it writes, and nothing it only reads', () => {
  it.each<[string, (adapter: InstanceAdapter) => Promise<unknown>, (root: string) => string[]]>([
    ['a commit of a mod folder, staged into an index of its own', (adapter) => adapter.commitFolder(join(root, 'mods', 'Mod A'), 'Init'), (at) => [join(at, '.git')]],
    ['a source mod\'s submodule entry written by git config -f, its branch read', async (adapter) => adapter.writeSubmodules('every', await adapter.sourceModFolders()), (at) => [join(at, '.gitmodules')]],
    ['the repository\'s own config written for the path tokens', (adapter) => adapter.writePathTokens(), (at) => [join(at, '.git')]],
    ['a source mod\'s remotes read', (adapter) => adapter.sourceHost(join(root, 'source', 'Mod A')), () => []],
    ['a submodule read from .gitmodules', async (adapter) => {
      await adapter.writeSubmodules('every', await adapter.sourceModFolders());
      named.length = 0;
      return adapter.submodule('Mod A');
    }, () => []],
    ['the hooks path read', (adapter) => adapter.checkPushRefusalFree(), () => []],
    ['a reading\'s check that a file staged under a path token filter was filtered', async (adapter) => {
      await put('profiles/Default/modlist.txt', '');
      await put('profiles/Default/plugins.txt', '');
      await adapter.writePathTokens();
      git(root, 'add', '--', 'ModOrganizer.ini');
      named.length = 0;
      unnamed = 0;
      return adapter.reading();
    }, () => []],
  ])('for %s', async (_gesture, gesture, files) => {
    const adapter = adapterOver(root);
    listening();

    await gesture(adapter);

    expect({ named: [...new Set(named)].sort(), unnamed }).toEqual({ named: files(root), unnamed: 0 });
  });

  it('names .gitmodules for a source folder\'s entry renamed', async () => {
    const adapter = adapterOver(root);
    await adapter.writeSubmodules('every', await adapter.sourceModFolders());
    listening();

    await adapter.followFoldersInRepository([{ from: join(root, 'source', 'Mod A'), to: join(root, 'source', 'Renamed') }]);

    expect({ named: [...new Set(named)], unnamed }).toEqual({ named: [join(root, '.gitmodules')], unnamed: 0 });
  });
});
