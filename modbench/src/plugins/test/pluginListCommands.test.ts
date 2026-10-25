import type { InstanceValue } from '../../instanceLoader/instance';
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

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showInputBox, showQuickPick, withProgress: recordedWithProgress },
    Uri: { file: (p: string) => ({ fsPath: p }), from: uriFrom },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, ThemeColor, EventEmitter,
  };
});

import {
  pluginsCopyValueText, registerCreatePluginCommand, registerRevealInExplorerCommand,
} from '../pluginListCommands';
import { PLUGINS_KEY_ARGS } from '../gestureEntry';
import type { RecordBrowserNode } from '../RecordBrowser';
import { recordSummaryFixture } from '../../client/test/fixtures';
import { cellRow, placedRow, recordGroupRow, recordRow, worldspaceRow } from './browserRows';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../pluginRows';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';
import { AgentCall } from '../../drivingLib/agentGesture';
import { progressSteps } from '../../test/recordedProgress';

beforeEach(() => {
  progressSteps.length = 0;
  handlers.clear();
  vi.clearAllMocks();
  executeCommand.mockReset();
  showInputBox.mockReset();
  showQuickPick.mockReset();
});

const plugin = (name: string, origin: string, path: string): LoadOrderPlugin =>
  ({ name, origin, path, line: null, enabled: false, winning: true });

function makeMo2() {
  return {
    instance: {
      refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
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
          sourceDirs: new Map([['Winning Mod', '/instance/source/Winning Mod']]),
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
      { method: 'createPlugin', args: [{ name: 'MyPatch.esp', origin: 'Winning Mod' }, '/instance/mods/Winning Mod', '/instance/source/Winning Mod'] },
    ]);
    expect(reporter.landings).toEqual(['Created "MyPatch.esp" in Winning Mod.']);
    expect(reporter.reports).toEqual([]);
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
  });

  it('reports why, and opens no prompt, when mEdit cannot say which extensions a plugin may take', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getCreatablePluginExtensions', { failed: 'refused', refusal: 'No load order has been loaded.' });

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

  it.each<[string, (value: InstanceValue) => InstanceValue, string]>([
    ['vanished, naming it', (value) => ({ ...value, mods: [], paths: { ...value.paths, modDirs: new Map() } }),
      'The mod "Winning Mod" is gone, so "MyPatch.esp" was not created.'],
    ['was disabled, saying so', (value) => ({ ...value, mods: [{ kind: 'mod', name: 'Winning Mod', enabled: false }] }),
      'The mod "Winning Mod" was disabled, so "MyPatch.esp" was not created.'],
  ])('refuses a mod that %s between the pick and the answer, and creates nothing', async (_what, changed, message) => {
    const client = new InMemoryMEditClient();
    const mo2 = makeMo2();
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockImplementation((places: Place[]) => {
      mo2.instance.value = changed(mo2.instance.value);
      return Promise.resolve(places.find((p) => p.origin === 'Winning Mod'));
    });

    const { run, reporter } = invoke(client, mo2);
    await run();

    expect(client.calls).toEqual([extensionsQuery]);
    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
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

  it('ends on the read after the file is written, so the rows show the plugin when the gesture ends', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { name: 'MyPatch.esp', origin: 'overwrite/' });
    showInputBox.mockResolvedValue('MyPatch.esp');
    showQuickPick.mockResolvedValue({ label: 'Overwrite', origin: 'overwrite/' });
    const mo2 = makeMo2();

    const { run } = invoke(client, mo2);
    await run();

    expect(progressSteps).toEqual(['progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes']);
  });
});

describe('modbench.plugin.create, called by the agent', () => {
  const place = (origin: string, name = 'MyPatch.esp') => new AgentCall([], { name, place: origin });

  function invokeAgent(call: AgentCall<{ name: string; place: string }>, client = new InMemoryMEditClient(), paths: Partial<InstanceValue['paths']> = {}) {
    const mo2 = makeMo2();
    mo2.instance.value = { ...mo2.instance.value, paths: { ...mo2.instance.value.paths, ...paths } };
    const reporter = recordingReporter();
    registerCreatePluginCommand(client, mo2.instance, reporter);
    const run = present(handlers.get('modbench.plugin.create'), "the create plugin command's registered handler");
    return { client, reporter, answer: (): Promise<unknown> => Promise.resolve(run(call)) };
  }

  it('creates the plugin named in the place given, opening and reporting nothing, and answers the outcome', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', WROTE);
    const { reporter, answer } = invokeAgent(place('Winning Mod'), client);

    const answered = await answer();

    expect(client.calls.at(-1)).toEqual(
      { method: 'createPlugin', args: [WROTE, '/instance/mods/Winning Mod', '/instance/source/Winning Mod'] });
    expect(answered).toEqual({ applied: true, outcome: { landed: [WROTE], refused: [] } });
    expect(showInputBox).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('takes the place without regard to case, as the view compares places, and creates in its own spelling', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', WROTE);
    const { answer } = invokeAgent(place('winning MOD'), client);

    await answer();

    expect(client.calls.at(-1)).toEqual(
      { method: 'createPlugin', args: [WROTE, '/instance/mods/Winning Mod', '/instance/source/Winning Mod'] });
  });

  it('answers the refusal mEdit gave, with its reason and reporting nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('createPlugin', { refused: true, message: 'A file is already there.' });
    const { reporter, answer } = invokeAgent(place('Winning Mod'), client);

    expect(await answer()).toEqual({ applied: false, refusal: 'A file is already there.' });
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['a place that is not an enabled mod', place('Disabled Mod'), {}, '"Disabled Mod" is not an enabled mod or Overwrite that lacks "MyPatch.esp".'],
    ['a place that already holds the name', place('Holding Mod'), {}, '"Holding Mod" is not an enabled mod or Overwrite that lacks "MyPatch.esp".'],
    ['an Overwrite whose folder is unread', place('overwrite/'), { overwriteDir: undefined }, 'Overwrite has no folder yet, so "MyPatch.esp" was not created.'],
  ])('refuses %s, creating nothing', async (_what, call, paths, reason) => {
    const { client, answer } = invokeAgent(call, undefined, paths);

    await expect(answer()).rejects.toThrow(reason);

    expect(client.calls).toEqual([]);
  });
});

describe('registerRevealInExplorerCommand', () => {
  function invoke(resolvePluginPath: (name: string) => Promise<string | undefined>, viewSelection: readonly PluginsTreeNode[] = []) {
    const reporter = recordingReporter();
    registerRevealInExplorerCommand(
      { resolvePluginPath: (row) => resolvePluginPath(row.kind === 'plugin' ? row.plugin.name : row.name) }, reporter, () => viewSelection);
    return { run: present(handlers.get('modbench.plugin.reveal'), "the reveal plugin command's registered handler"), reporter };
  }

  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data/');
  const plugin = new PluginNode({ name: 'MyMod.esp', enabled: true }, 'SomeMod');

  it.each<[string, PluginsTreeNode | undefined, readonly PluginsTreeNode[], string]>([
    ['a locked row\'s file, resolved from the row', locked, [], '/files/Fallout4.esm'],
    ['the one selected locked row from the palette', undefined, [locked], '/files/Fallout4.esm'],
    ['a plugin row\'s file', plugin, [], '/files/MyMod.esp'],
    ['the one selected plugin from the palette', undefined, [plugin], '/files/MyMod.esp'],
  ])('reveals %s in the OS explorer and says nothing', async (_what, clicked, selection, fsPath) => {
    const { run, reporter } = invoke((name) => Promise.resolve(`/files/${name}`), selection);

    await run(clicked);

    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', { fsPath });
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it.each([
    ['a locked row', locked, 'Could not resolve a file location for "Fallout4.esm" — the instance does not list this file.'],
    ['a plugin row', plugin, 'Could not resolve a file location for "MyMod.esp" — no mod or Overwrite holds this file.'],
  ])('reports at error why %s resolves to no file, and reveals nothing', async (_what, clicked, message) => {
    const { run, reporter } = invoke(() => Promise.resolve(undefined));

    await run(clicked);

    expect(reporter.reports).toEqual([{ severity: 'error', message, detail: undefined }]);
    expect(executeCommand).not.toHaveBeenCalled();
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
