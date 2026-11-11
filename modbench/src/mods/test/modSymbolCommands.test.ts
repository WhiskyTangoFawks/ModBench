import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, Uri } from '../../test/vscodeMock';

const { handlers, executeCommand } = vi.hoisted(() => ({
  handlers: new Map<string, (clicked?: unknown) => Promise<void>>(),
  executeCommand: vi.fn(() => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (command: string, handler: (clicked?: unknown) => Promise<void>) => { handlers.set(command, handler); return { dispose: vi.fn() }; },
    executeCommand,
  },
  Uri,
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
}));

import { registerGoToModRowCommand, registerModReferencedByCommand } from '../modSymbolCommands';
import { ModNode, type ModlistNode } from '../ModListProvider';
import { ArchivedFileNode, FileNode } from '../modFiles';
import { file } from './indexedValue';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';

const aRow = new ModNode({ kind: 'mod', name: 'Base Mod', enabled: true });
const asked = { argument: { kind: 'mod', name: 'Base Mod' } };

describe('the mod go to command (commands.md, `go to` under Mod)', () => {
  beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

  function setup(selection: readonly ModNode[] = []) {
    const reveal = vi.fn((_row: ModlistNode) => Promise.resolve());
    const asking = vi.fn((_mod: string) => aRow);
    registerGoToModRowCommand({ rowOf: asking, folderOf: () => '/mods/Base Mod', reveal, reporter: recordingReporter() }, () => selection);
    return { reveal, asking, run: present(handlers.get('modbench.mod.goTo'), 'the go to command') };
  }

  it('goes to the mod the clicked row carries, which Mods shows as that row', async () => {
    const { reveal, asking, run } = setup();

    await run(asked);

    expect([asking.mock.calls, reveal.mock.calls, executeCommand.mock.calls]).toEqual([[['Base Mod']], [[aRow]], []]);
  });

  it('takes the one selected row from the palette', async () => {
    const { asking, run } = setup([aRow]);

    await run();

    expect(asking.mock.calls).toEqual([['Base Mod']]);
  });
});

describe('the mod referenced by command (commands.md, `referenced by` under Mod)', () => {
  beforeEach(() => { handlers.clear(); });

  const WALL = file('mods/Walls', 'meshes/architecture/wall.nif');
  const GAME_WALL = { relativePath: 'meshes/architecture/gamewall.nif', path: '/game/Data/meshes/architecture/gamewall.nif' };

  function setup() {
    const mod = vi.fn((_mod: string) => Promise.resolve());
    const files = vi.fn((_path: string) => Promise.resolve());
    const reporter = recordingReporter();
    const value = {
      filesByMod: new Map([['Walls', [WALL]]]),
      dataFolderFiles: { kind: 'listed' as const, files: new Map([[GAME_WALL.relativePath, GAME_WALL]]) },
    };
    registerModReferencedByCommand({ mod, file: files, value: () => value, reporter }, () => []);
    return { mod, files, reporter, run: present(handlers.get('modbench.mod.referencedBy'), 'the referenced by command') };
  }

  it('lists the places that name the mod the row stands for', async () => {
    const { mod, run } = setup();

    await run(asked);

    expect(mod.mock.calls).toEqual([['Base Mod']]);
  });

  it('lists nothing for a row that is no mod', async () => {
    const { mod, files, run } = setup();

    await run({ argument: { kind: 'separator', name: 'Gear' } });

    expect([mod.mock.calls, files.mock.calls]).toEqual([[], []]);
  });

  it('lists the records that name a file row\'s path in the Data folder, a loose file\'s or one in an archive', async () => {
    const { files, run } = setup();
    const wall = new FileNode(aRow, { kind: 'mod', name: 'Base Mod' }, WALL, 'wall.nif');
    const archive = new FileNode(aRow, { kind: 'mod', name: 'Base Mod' }, file('mods/Walls', 'Walls - Main.ba2'), 'Walls - Main.ba2');

    await run(wall);
    await run(new ArchivedFileNode(archive, archive, 'meshes/architecture/door.nif', 'door.nif', undefined));

    expect(files.mock.calls).toEqual([['meshes/architecture/wall.nif'], ['meshes/architecture/door.nif']]);
  });

  it('lists the records that name a file the Explorer shows, in a mod or the game\'s Data folder, by its path in the Data folder', async () => {
    const { files, run } = setup();

    await run(Uri.file(WALL.path));
    await run(Uri.file(GAME_WALL.path));

    expect(files.mock.calls).toEqual([[WALL.relativePath], [GAME_WALL.relativePath]]);
  });

  it('refuses a file the Explorer shows in no mod and outside the game\'s Data folder', async () => {
    const { files, reporter, run } = setup();

    await run(Uri.file('/instance/profiles/Default/modlist.txt'));

    expect([files.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});
