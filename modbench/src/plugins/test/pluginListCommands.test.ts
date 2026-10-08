import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter, uriFrom,
} from '../../test/vscodeMock';

const {
  handlers, registerCommand, executeCommand, showInputBox, showQuickPick,
} = vi.hoisted(() => {
  const handlers = new Map<string, (ctx?: unknown) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (ctx?: unknown) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showInputBox, showQuickPick },
  Uri: { file: (p: string) => ({ fsPath: p }), from: uriFrom },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
}));

import {
  pluginsCopyValueText, registerCreatePluginCommand, registerPluginSortCommands, registerRevealInExplorerCommand,
} from '../pluginListCommands';
import { PLUGINS_KEY_ARGS } from '../gestureEntry';
import type { RecordBrowserNode } from '../RecordBrowser';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { cellRow, placedRow, recordGroupRow, recordRow, worldspaceRow } from './browserRows';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { pluginsTreeOver } from './pluginsTreeOver';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { expectInstancesOf } from '../../test/expectInstanceOf';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  executeCommand.mockReset();
  showInputBox.mockReset();
  showQuickPick.mockReset();
});

const plugin = (name: string, origin: string, path: string): LoadOrderPlugin =>
  ({ name, origin, path, slot: null, enabled: false, winning: true });

function makeMo2() {
  return {
    instance: {
      value: instanceValueFixture({
        mods: [
          { kind: 'mod', name: 'Winning Mod', enabled: true },
          { kind: 'mod', name: 'Disabled Mod', enabled: false },
          { kind: 'mod', name: 'Holding Mod', enabled: true },
        ],
        plugins: [plugin('MyPatch.esp', 'Holding Mod', '/instance/mods/Holding Mod/MyPatch.esp')],
        paths: {
          overwriteDir: '/instance/overwrite',
          downloadsDir: '/instance/downloads',
          modDirs: new Map([
            ['Winning Mod', '/instance/mods/Winning Mod'],
            ['Disabled Mod', '/instance/mods/Disabled Mod'],
            ['Holding Mod', '/instance/mods/Holding Mod'],
          ]),
        },
      }),
    },
  };
}

const WROTE = { name: 'MyPatch.esp', origin: 'Winning Mod' };

describe('registerCreatePluginCommand', () => {
  function invoke(client: InMemoryMEditClient, mo2: ReturnType<typeof makeMo2>, creatableExtensions = ['.esm', '.esl', '.esp']) {
    client.setQueryAnswer('getCreatablePluginExtensions', creatableExtensions);
    const reporter = recordingReporter();
    registerCreatePluginCommand(client, mo2.instance, reporter);
    return { run: present(handlers.get('modbench.plugin.create'), "the create plugin command's registered handler"), reporter };
  }

  const extensionsQuery = { method: 'getCreatablePluginExtensions', args: [] };

  type Place = { label: string; origin: string };
  const offering = (): { offered: Place[] } => {
    const pick = { offered: [] as Place[] };
    showQuickPick.mockImplementation((places: Place[]) => {
      pick.offered = places;
      return Promise.resolve(undefined);
    });
    return pick;
  };
  const pickOrigin = (origin: string) => showQuickPick.mockImplementation((places: Place[]) =>
    Promise.resolve(places.find((p) => p.origin === origin)));

  it('sends the origin, the file name and the picked place\'s folder, and lands the created toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', WROTE);
    showInputBox.mockResolvedValue('MyPatch.esp');
    pickOrigin('Winning Mod');

    const { run, reporter } = invoke(client, makeMo2());
    await run();

    expect(client.calls).toEqual([
      extensionsQuery,
      { method: 'createPlugin', args: [{ name: 'MyPatch.esp', origin: 'Winning Mod' }, '/instance/mods/Winning Mod'] },
    ]);
    expect(reporter.landings).toEqual(['Created "MyPatch.esp" in Winning Mod.']);
    expect(reporter.reports).toEqual([]);
  });

  it('refuses an empty name and a name that is not .esp, .esm or .esl', async () => {
    type Validate = (v: string) => string | undefined;
    const prompt: { validate?: Validate } = {};
    showInputBox.mockImplementation((options: { validateInput: Validate }) => {
      prompt.validate = options.validateInput;
      return Promise.resolve(undefined);
    });
    const { run } = invoke(new InMemoryMEditClient(), makeMo2());
    await run();

    const validate = present(prompt.validate, 'the name prompt\'s validator');
    expect(validate('')).toBe('Name is required');
    expect(validate('MyPatch.txt')).toBe('Extension must be .esm, .esl, or .esp');
    expect(validate('MyPatch')).toBe('Extension must be .esm, .esl, or .esp');
    expect(validate('.esp')).toBe('Extension must be .esm, .esl, or .esp');
    expect(['A.esp', 'B.ESM', 'C.esl'].map(validate)).toEqual([undefined, undefined, undefined]);
  });

  it('refuses an extension mEdit leaves out inline, naming the ones it allows', async () => {
    type Validate = (v: string) => string | undefined;
    const prompt: { validate?: Validate } = {};
    showInputBox.mockImplementation((options: { validateInput: Validate }) => {
      prompt.validate = options.validateInput;
      return Promise.resolve(undefined);
    });
    const { run } = invoke(new InMemoryMEditClient(), makeMo2(), ['.esm', '.esp']);
    await run();

    const validate = present(prompt.validate, 'the name prompt\'s validator');
    expect(validate('MyPatch.esl')).toBe('Extension must be .esm or .esp');
    expect(['A.esp', 'B.ESM'].map(validate)).toEqual([undefined, undefined]);
  });

  it('reports why, and opens no prompt, when mEdit cannot say which extensions a plugin may take', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getCreatablePluginExtensions', new Error('No load order has been loaded.'));

    const { run, reporter } = invoke(client, makeMo2());
    await run();

    expect(showInputBox).not.toHaveBeenCalled();
    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not look up which extensions a plugin may take.', detail: 'No load order has been loaded.' },
    ]);
  });

  it('picks the enabled mods first, then Overwrite, leaving out the place that holds the name', async () => {
    showInputBox.mockResolvedValue('mypatch.ESP');
    const pick = offering();

    const { run } = invoke(new InMemoryMEditClient(), makeMo2());
    await run();

    expect(pick.offered.map((p) => p.label)).toEqual(['Winning Mod', 'Overwrite']);
  });

  it('creates nothing and asks for no place when Esc answers the name prompt', async () => {
    const client = new InMemoryMEditClient();
    showInputBox.mockResolvedValue(undefined);

    const { run, reporter } = invoke(client, makeMo2());
    await run();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([]);
  });

  it('creates nothing when Esc answers the place pick', async () => {
    const client = new InMemoryMEditClient();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue(undefined);

    const { run, reporter } = invoke(client, makeMo2());
    await run();

    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('refuses a mod that vanished between the pick and the answer, naming it, and creates nothing', async () => {
    const client = new InMemoryMEditClient();
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockImplementation((places: Place[]) => {
      mo2.instance.value = { ...mo2.instance.value, mods: [], paths: { ...mo2.instance.value.paths, modDirs: new Map() } };
      return Promise.resolve(places.find((p) => p.origin === 'Winning Mod'));
    });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'The mod "Winning Mod" is gone, so "MyPatch.esp" was not created.', detail: undefined },
    ]);
  });

  it('refuses a mod that was disabled between the pick and the answer, saying so, and creates nothing', async () => {
    const client = new InMemoryMEditClient();
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockImplementation((places: Place[]) => {
      mo2.instance.value = { ...mo2.instance.value, mods: [{ kind: 'mod', name: 'Winning Mod', enabled: false }] };
      return Promise.resolve(places.find((p) => p.origin === 'Winning Mod'));
    });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'The mod "Winning Mod" was disabled, so "MyPatch.esp" was not created.', detail: undefined },
    ]);
  });

  it('refuses Overwrite while the value names no folder for it, and creates nothing', async () => {
    const client = new InMemoryMEditClient();
    const mo2 = makeMo2();
    mo2.instance.value = { ...mo2.instance.value, paths: { ...mo2.instance.value.paths, overwriteDir: undefined } };
    showInputBox.mockResolvedValue('New.esp');
    showQuickPick.mockImplementation((places: Place[]) => Promise.resolve(places.find((p) => p.label === 'Overwrite')));

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Overwrite has no folder yet, so "New.esp" was not created.', detail: undefined },
    ]);
  });

  it('reports the refusal mEdit answered with at error, and lands no toast', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { refused: true, message: 'Could not create "MyPatch.esp" — A file is already there.' });
    showInputBox.mockResolvedValue('MyPatch.esp');
    pickOrigin('overwrite/');

    const { run, reporter } = invoke(client, makeMo2());
    await run();

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not create "MyPatch.esp" — A file is already there.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports that every place holds the name, and offers no empty pick', async () => {
    const mo2 = makeMo2();
    mo2.instance.value = {
      ...mo2.instance.value,
      mods: [{ kind: 'mod', name: 'Holding Mod', enabled: true }],
      plugins: [
        plugin('MyPatch.esp', 'Holding Mod', '/instance/mods/Holding Mod/MyPatch.esp'),
        plugin('MyPatch.esp', 'overwrite/', '/instance/overwrite/MyPatch.esp'),
      ],
    };
    showInputBox.mockResolvedValue('MyPatch.esp');

    const { run, reporter } = invoke(new InMemoryMEditClient(), mo2);
    await run();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Overwrite and every enabled mod already hold "MyPatch.esp".', detail: undefined },
    ]);
  });

  it('refreshes nothing once the plugin lands, and the rows show it when the next instance value arrives', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', origin: 'overwrite/' });
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ label: 'Overwrite', origin: 'overwrite/' });
    const mo2 = makeMo2();
    const instance = new FakeInstance(mo2.instance.value);
    const tree = pluginsTreeOver(instance);
    expect(await tree.getChildren()).toEqual([]);
    let changes = 0;
    tree.onDidChangeTreeData(() => { changes++; });

    const { run } = invoke(client, { ...mo2, instance });
    await run();

    expect(changes).toBe(0);
    expect(await tree.getChildren()).toEqual([]);

    instance.publish(instanceValueFixture({
      ...mo2.instance.value,
      plugins: [{ name: 'MyPatch.esp', path: '/instance/overwrite/MyPatch.esp', origin: 'overwrite/', slot: 0, enabled: true, winning: true }],
    }));

    expect(changes).toBeGreaterThan(0);
    expect(expectInstancesOf(await tree.getChildren(), PluginNode).map((row) => row.plugin.name)).toEqual(['MyPatch.esp']);
  });
});

describe('registerRevealInExplorerCommand', () => {
  function invoke(resolvePluginPath: (name: string) => Promise<string | undefined>, viewSelection: readonly PluginsTreeNode[] = []) {
    const reporter = recordingReporter();
    registerRevealInExplorerCommand(
      { resolvePluginPath: (row) => resolvePluginPath(row.kind === 'plugin' ? row.plugin.name : row.name) }, reporter, () => viewSelection);
    return { run: present(handlers.get('modbench.plugin.reveal'), "the reveal plugin command's registered handler"), reporter };
  }

  it('reveals a locked row\'s file, resolved from the row', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`));

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data/'));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('says the game folder was not found when a locked row resolves to no file', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data/'));

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not resolve a file location for "Fallout4.esm" — the game folder was not found.', detail: undefined,
    }]);
  });

  it('reveals the one selected locked row from the palette', async () => {
    const { run } = invoke((name) => Promise.resolve(`/game/Data/${name}`), [new ImplicitMasterNode('Fallout4.esm', 'Data/')]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/game/Data/Fallout4.esm' });
  });

  it('reveals the resolved file in the OS explorer and says nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/MyMod.esp' });
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports an unresolved file location at error, naming why, rather than doing nothing', async () => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(reporter.reports).toEqual([
      {
        severity: 'error',
        message: 'Could not resolve a file location for "MyMod.esp" — no mod or Overwrite holds this file.',
        detail: undefined,
      },
    ]);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reveals the one selected plugin from the palette', async () => {
    const { run } = invoke(
      (name) => Promise.resolve(`/instance/mods/MyMod/${name}`), [new PluginNode({ name: 'Selected.esp', enabled: true }, 'SomeMod')]);

    await run();

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath: '/instance/mods/MyMod/Selected.esp' });
  });

  it('reveals nothing from the palette over a selection of several plugins', async () => {
    const { run } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'), [
      new PluginNode({ name: 'A.esp', enabled: true }, 'SomeMod'), new PluginNode({ name: 'B.esp', enabled: true }, 'SomeMod'),
    ]);

    await run();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports a rejected reveal at error with the thrown message as its detail', async () => {
    executeCommand.mockRejectedValue(new Error('no file manager'));
    const { run, reporter } = invoke(() => Promise.resolve('/instance/mods/MyMod/MyMod.esp'));

    await run(new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to reveal "MyMod.esp" in Explorer.', detail: 'no file manager' },
    ]);
  });
});

describe('pluginsCopyValueText', () => {
  const plugin = new PluginNode({ name: 'Alpha.esp', enabled: true }, 'ModA');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data/');
  const ALPHA = { name: 'Alpha.esp', origin: 'ModA' };
  let record: RecordBrowserNode;
  let mixed: (RecordBrowserNode | PluginNode | ImplicitMasterNode)[];
  beforeAll(async () => {
    record = await recordRow(recordSummaryFixture({ formKey: '000800:Alpha.esp', plugin: 'Alpha.esp', editorId: 'Gun' }), 'ModA');
    mixed = [
      plugin, record, locked,
      await recordRow(recordSummaryFixture({ formKey: '000801:Alpha.esp', plugin: 'Alpha.esp', editorId: null }), 'ModA'),
      await worldspaceRow({ formKey: '000802:Alpha.esp', editorId: 'World', hasParseFailure: false, workingTreeState: 'None', hasChildren: true }, ALPHA),
      await cellRow({
        formKey: '000803:Alpha.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, fullName: 'A Room', hasParseFailure: false, workingTreeState: 'None',
      }, ALPHA),
      await placedRow({
        formKey: '000804:Alpha.esp', editorId: null, baseFormKey: '000800:Alpha.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'None',
      }, ALPHA),
      await recordGroupRow({ type: 'weap', count: 2, displayName: 'Weapon' }, ALPHA),
    ];
  });
  const LINES = [
    'Alpha.esp', 'Gun [000800:Alpha.esp]', 'Fallout4.esm', '000801:Alpha.esp',
    'World [000802:Alpha.esp]', 'Room [000803:Alpha.esp]', '000804:Alpha.esp',
  ].join('\n');

  it('copies a mixed selection right-clicked in the tree, a row that stands for neither adding nothing', () => {
    expect(pluginsCopyValueText(() => mixed)(record, mixed)).toBe(LINES);
  });

  it('copies the selection the Plugins key hands it', () => {
    expect(pluginsCopyValueText(() => mixed)(PLUGINS_KEY_ARGS, undefined)).toBe(LINES);
  });

  it('copies the right-clicked row alone when it is outside the selection', () => {
    expect(pluginsCopyValueText(() => mixed)(locked, undefined)).toBe('Fallout4.esm');
  });

  it('defers what is not the Plugins view\'s', () => {
    const copy = pluginsCopyValueText(() => mixed);
    expect(copy(undefined, undefined)).toBeUndefined();
    expect(copy({ view: 'modbench.modList' }, undefined)).toBeUndefined();
    expect(copy(new TreeItem('a Mods row'), undefined)).toBeUndefined();
  });
});

describe('registerPluginSortCommands', () => {
  const pluginKey = () => executeCommand.mock.calls
    .filter((c) => c[0] === 'setContext' && (c as unknown[])[1] === 'modbench.plugin.winningAtTop')
    .map((c) => (c as unknown[])[2]);

  it('registers both title-bar commands and drives the manifest\'s winningAtTop key', async () => {
    const setViewDirection = vi.fn();
    registerPluginSortCommands({ setViewDirection });

    expect([...handlers.keys()].sort()).toEqual(['modbench.plugin.sortLosingAtTop', 'modbench.plugin.sortWinningAtTop']);
    expect(pluginKey()).toEqual([false]);

    await present(handlers.get('modbench.plugin.sortWinningAtTop'), 'sortWinningAtTop')();
    expect(setViewDirection).toHaveBeenCalledWith('winningAtTop');
    expect(pluginKey()).toEqual([false, true]);
  });
});
