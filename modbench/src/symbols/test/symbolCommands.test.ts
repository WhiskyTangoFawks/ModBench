import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri } from '../../test/vscodeMock';

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
}));

import { registerGoToMod, registerGoToPlugin, registerModReferencedBy, registerPluginReferencedBy } from '../symbolCommands';
import type { OriginFile } from '../../instanceLoader/instance';
import { present } from '../../ports/present';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { ModRows, PluginRows } from '../../drivingLib/symbolRows';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';
import type { Definition } from '../symbolKind';
import { fakeKind, fakeKinds } from './fakeKinds';

const askedMod = { argument: { kind: 'mod', name: 'Base Mod' } };
const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const askedPlugin = { argument: { kind: 'plugin', plugin: BASE } };

beforeEach(() => { handlers.clear(); executeCommand.mockClear(); });

function modRows(over: Partial<ModRows> = {}) {
  const rows: ModRows = { selected: () => undefined, show: () => undefined, folderOf: () => undefined, dataPathOf: () => undefined, ...over };
  return { rows };
}

describe('the go to commands present the symbol\'s definition (commands.md, `go to` under Symbol)', () => {
  const FOLDER = { kind: 'loose', path: '/mods/Base Mod' } as const;

  function setup(definition: Definition, selected?: unknown) {
    const show = vi.fn(() => Promise.resolve());
    const reveal = vi.fn((_copy: CopyAt) => Promise.resolve());
    const definitionOf = vi.fn((_symbol: never) => Promise.resolve('row' in definition ? { ...definition, show } : definition));
    const reporter = recordingReporter();
    const kinds = fakeKinds({ entry: fakeKind({ definitionOf }), plugin: fakeKind({ definitionOf }) });
    registerGoToMod({ kinds, reveal, reporter, rows: { selected: () => selected } });
    registerGoToPlugin({ kinds, reveal, reporter, rows: { selected: () => selected } });
    return { show, reveal, definitionOf, reporter, run: (command: string) => present(handlers.get(command), 'the go to command') };
  }

  it('selects the mod\'s row, for the mod the clicked row carries', async () => {
    const { show, definitionOf, run } = setup({ row: 'Mods', show: () => Promise.resolve() });

    await run('modbench.mod.goTo')(askedMod);

    expect([definitionOf.mock.calls, show.mock.calls.length, executeCommand.mock.calls]).toEqual([[[{ kind: 'mod', name: 'Base Mod' }]], 1, []]);
  });

  it('takes the one selected row from the palette', async () => {
    const { definitionOf, run } = setup({ row: 'Mods', show: () => Promise.resolve() }, askedMod);

    await run('modbench.mod.goTo')();

    expect(definitionOf.mock.calls).toEqual([[{ kind: 'mod', name: 'Base Mod' }]]);
  });

  it('shows the copy its definition names in the Explorer', async () => {
    const { reveal, run } = setup({ shown: FOLDER });

    await run('modbench.mod.goTo')(askedMod);

    expect(reveal.mock.calls).toEqual([[FOLDER]]);
  });

  it('says why it cannot go where the symbol has no definition', async () => {
    const { reporter, run } = setup({ refused: 'Mods shows no row for it and no folder holds it.' });

    await run('modbench.mod.goTo')(askedMod);

    expect(reporter.reports.map(({ severity, message }) => [severity, message])).toEqual([['error', 'Could not go to "Base Mod": Mods shows no row for it and no folder holds it.']]);
  });

  it('selects the plugin\'s row, for the plugin an Argument carries', async () => {
    const { show, definitionOf, reporter, run } = setup({ row: 'Plugins', show: () => Promise.resolve() });

    await run('modbench.plugin.goTo')(askedPlugin);

    expect([definitionOf.mock.calls, show.mock.calls.length, reporter.reports]).toEqual([[[{ kind: 'plugin', ...BASE }]], 1, []]);
  });
});

describe('the mod referenced by command (commands.md, `referenced by` under Symbol)', () => {
  const WALL: OriginFile = { relativePath: 'meshes/architecture/wall.nif', path: '/instance/mods/Walls/meshes/architecture/wall.nif', sourcePath: '/instance/mods/Walls/meshes/architecture/wall.nif', excluded: false, markedExcluded: false, includedPath: 'meshes/architecture/wall.nif' };
  const GAME_WALL = { relativePath: 'meshes/architecture/gamewall.nif', path: '/game/Data/meshes/architecture/gamewall.nif' };

  function setup(over: Partial<ModRows> = {}) {
    const mod = vi.fn((_mod: string) => Promise.resolve());
    const files = vi.fn((_path: string) => Promise.resolve());
    const reporter = recordingReporter();
    const value = {
      filesByMod: new Map([['Walls', [WALL]]]),
      dataFolderFiles: { kind: 'listed' as const, files: new Map([[GAME_WALL.relativePath, GAME_WALL]]) },
    };
    registerModReferencedBy({ referencedBy: { mod, file: files }, rows: modRows(over).rows, value: () => value, reporter });
    return { mod, files, reporter, run: present(handlers.get('modbench.mod.referencedBy'), 'the referenced by command') };
  }

  it('lists the places that name the mod the row stands for', async () => {
    const { mod, run } = setup();

    await run(askedMod);

    expect(mod.mock.calls).toEqual([['Base Mod']]);
  });

  it('lists nothing for a row that is no mod', async () => {
    const { mod, files, run } = setup();

    await run({ argument: { kind: 'separator', name: 'Gear' } });

    expect([mod.mock.calls, files.mock.calls]).toEqual([[], []]);
  });

  it('lists the records that name the path the view says a file row stands for, and no mod', async () => {
    const fileRow = { a: 'file row' };
    const { mod, files, run } = setup({ dataPathOf: (clicked) => clicked === fileRow ? 'meshes/architecture/door.nif' : undefined });

    await run(fileRow);
    await run({ a: 'row the view says no file for' });

    expect([files.mock.calls, mod.mock.calls]).toEqual([[['meshes/architecture/door.nif']], []]);
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

function pluginRows(over: Partial<PluginRows> = {}) {
  const rows: PluginRows = { selected: () => undefined, show: () => undefined, fileOf: () => undefined, ...over };
  return { rows };
}

describe('the plugin referenced by command (plugins.md, Menus and keys)', () => {
  const OTHER = { name: 'Other.esp', origin: 'Other' };

  it.each<[string, unknown, unknown, { name: string; origin: string } | undefined]>([
    ['the plugin an Argument carries', askedPlugin, undefined, BASE],
    ['the one selected plugin from the palette', undefined, { argument: { kind: 'plugin', plugin: OTHER } }, OTHER],
    ['no plugin from the palette with none selected', undefined, undefined, undefined],
  ])('lists where files name %s', async (_what, clicked, selected, listed) => {
    const asked: { name: string; origin: string }[] = [];
    registerPluginReferencedBy({ referencedBy: (named) => { asked.push(named); return Promise.resolve(); }, rows: pluginRows({ selected: () => selected }).rows });

    await present(handlers.get('modbench.plugin.referencedBy'), 'the referenced by handler')(clicked);

    expect(asked).toEqual(listed ? [listed] : []);
  });
});
