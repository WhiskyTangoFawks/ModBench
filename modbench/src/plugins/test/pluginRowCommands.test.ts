import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, showQuickPick, createQuickPick, executeCommand,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn<
      (items: readonly { label: string; description?: string }[], options?: unknown) =>
        Promise<{ label: string; description?: string }[] | undefined>
    >(),
    createQuickPick: vi.fn(),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState, Diagnostic, DiagnosticSeverity, Range, Uri,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
    Diagnostic, DiagnosticSeverity, Range,
    Uri,
  };
});

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';

import { registerDecompileAndRepairCommand, registerDecompileCommand } from '../pluginRowCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { PluginNode } from '../pluginRows';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import type { PluginAddress } from '../../client';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.plugin.decompile', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };

  function row(plugin: { name: string; origin: string }): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = 'plugin enabled inSourceMod nonCompiledPlugin editable';
    return node;
  }

  function registered(client: InMemoryMEditClient, answer: string | undefined, viewSelection: readonly PluginNode[] = []) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(answer);
    registerDecompileCommand({
      client: {
        decompile: (plugins, force) => {
          progressSteps.push(`decompile ${plugins.map(({ name }) => name).join(', ')}${force ? ' forced' : ''}`);
          return client.decompile(plugins, force);
        },
        getWorkingTreeStatesBeneath: (plugin) => client.getWorkingTreeStatesBeneath(plugin),
      },
      instance: instanceThatReads,
      reporter, ask,
    }, () => viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.decompile'), 'the decompile command registerDecompileCommand registers'),
      reporter, ask,
    };
  }

  const decompileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'decompile').map((c) => c.args);

  const beneath = (...plugin: ('None' | 'Modified' | 'Added')[]) => ({ plugin, recordTypes: {}, records: {} });
  const clean = beneath('None');
  const changedSource = beneath('Modified');

  it('on a plugin row whose source git holds, decompiles it unforced asking nothing, the view\'s progress bar closing once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');

    await handler(row(SECOND));

    expect(ask.asked).toEqual([]);
    expect(decompileCalls(client)).toEqual([[[SECOND], false]]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'decompile Second.esp', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a plugin row whose source has changes git does not hold, asks naming it before any write, the progress bar closed while it waits', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', changedSource);
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');

    await handler(row(SECOND));

    expect(ask.asked).toEqual([{
      message: 'Decompile "Second.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile'],
    }]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'progress closes',
      'progress opens on modbench.pluginListTree', 'decompile Second.esp forced', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
  });

  it('on a selection, asks once naming only the plugins with such changes, then sends them forced and the rest unforced', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { landed: [FIRST], refused: [] });
    client.setCommandHandler('decompile', (plugins) => Promise.resolve({ landed: plugins, refused: [] }));
    const { handler, reporter, ask } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile "First.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST], true], [[SECOND], false]]);
    expect(reporter.landings).toEqual(['Decompiled 2 plugins.']);
  });

  it('names several plugins with such changes in the one prompt\'s detail', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', changedSource);
    client.setCommandHandler('decompile', (plugins) => Promise.resolve({ landed: plugins, refused: [] }));
    const { handler, ask } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile 2 plugins? They replace changes to their source that git does not hold.',
      detail: 'First.esp (ModA)\nSecond.esp (ModA)',
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST, SECOND], true]]);
  });

  it('writes nothing and says nothing when the confirmation is dismissed', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    const { handler, reporter, ask } = registered(client, undefined);
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(ask.asked).toHaveLength(1);
    expect(decompileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports mEdit\'s working-tree refusal as it comes back, without a second ask, when the tree changed after the read', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    const refusal = 'First.esp\'s source has working-tree changes that decompile would replace.';
    client.setCommandResult('decompile', { landed: [], refused: [{ item: FIRST, reason: refusal }] });
    const { handler, reporter, ask } = registered(client, 'Decompile');

    await handler(row(FIRST));

    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not decompile "First.esp".', detail: `"First.esp (ModA)" (${refusal})` }]);
  });

  it('sends unforced for a plugin whose states cannot be read, leaving mEdit\'s guard to refuse', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getWorkingTreeStatesBeneath', { failed: 'unreachable' });
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler, ask } = registered(client, 'Decompile');

    await handler(row(SECOND));

    expect(ask.asked).toEqual([]);
    expect(decompileCalls(client)).toEqual([[[SECOND], false]]);
  });

  it('reports what the forced send landed and the unforced send was refused when the unforced send is refused whole', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandHandler('decompile', (plugins, force) => Promise.resolve(force
      ? { landed: plugins, refused: [] }
      : { refused: true as const, message: 'git went away.' }));
    const { handler, reporter } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 of 2 plugins.', detail: '"Second.esp (ModA)" (git went away.)' },
    ]);
  });

  it('refuses the whole selection once, writing nothing further, when the forced send is refused whole', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', changedSource);
    client.setQueryAnswerOnce('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { refused: true, message: 'git was not found on PATH.' });
    const { handler, reporter } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(decompileCalls(client)).toEqual([[[FIRST], true]]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'git was not found on PATH.', detail: undefined }]);
  });

  it('names each refused plugin and why in one notification while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const refusal = 'First.esp does not round-trip through its own source.';
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { landed: [SECOND], refused: [{ item: FIRST, reason: refusal }] });
    const { handler, reporter } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 of 2 plugins.', detail: `"First.esp (ModA)" (${refusal})` },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    client.setCommandResult('decompile', { refused: true, message: 'Could not decompile 1 plugin — git was not found on PATH.' });
    const { handler, reporter } = registered(client, 'Decompile');

    await handler(row(SECOND));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });
});

describe('modbench.plugin.decompile, called by the agent', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const calling = (...plugins: { name: string; origin: string }[]) => new AgentCall(plugins.map((plugin) => ({ kind: 'plugin' as const, plugin })), {});

  function registered(client: InMemoryMEditClient) {
    const reporter = recordingReporter();
    const ask = scriptedDialog('Decompile');
    registerDecompileCommand({ client, instance: instanceThatReads, reporter, ask }, () => [new PluginNode({ name: 'Selected.esp', enabled: true }, 'ModA')]);
    return { handler: present(handlers.get('modbench.plugin.decompile'), 'the decompile command'), reporter, ask };
  }

  it('decompiles the plugins given, never the selection, asking nothing and reporting nothing, and answers the outcome', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { landed: [SECOND], refused: [{ item: FIRST, reason: 'First.esp does not round-trip through its own source.' }] };
    client.setCommandResult('decompile', outcome);
    const { handler, reporter, ask } = registered(client);

    const answered = await handler(calling(FIRST, SECOND));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[FIRST, SECOND], false]]);
    expect(answered).toEqual({ applied: true, outcome });
    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('requests the decompile forced when its options say force', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler } = registered(client);

    await handler(new AgentCall([{ kind: 'plugin', plugin: SECOND }], { force: true }));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[SECOND], true]]);
  });

  it('answers the refusal of the whole selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { refused: true, message: 'git was not found on PATH.' });
    const { handler, reporter } = registered(client);

    expect(await handler(calling(SECOND))).toEqual({ applied: false, refusal: 'git was not found on PATH.' });
    expect(reporter.reports).toEqual([]);
  });

  it('refuses an Argument that is not a plugin, decompiling nothing', async () => {
    const client = new InMemoryMEditClient();
    const { handler } = registered(client);

    await expect(handler(new AgentCall([{ kind: 'mod', name: 'ModA' }], {}))).rejects.toBeInstanceOf(Refusal);

    expect(client.calls.filter((c) => c.method === 'decompile')).toEqual([]);
  });
});

describe('modbench.plugin.decompileAndRepair', () => {
  const MALFORMED = { name: 'Malformed.esp', origin: 'ModA' };
  const SELECTED = { name: 'Selected.esp', origin: 'ModA' };
  const beneath = (...plugin: ('None' | 'Modified' | 'Added')[]) => ({ plugin, recordTypes: {}, records: {} });
  const clean = beneath('None');
  const changedSource = beneath('Modified');

  function registered(viewSelection: readonly PluginNode[] = [], answers: readonly (string | undefined)[] = [], client = new InMemoryMEditClient()) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    const repaired: { plugins: readonly PluginAddress[]; force: boolean }[] = [];
    registerDecompileAndRepairCommand({
      commands: {
        decompileAndRepair: (plugins, force) => {
          progressSteps.push(`decompile and repair${force ? ' forced' : ''}`);
          repaired.push({ plugins, force });
          return Promise.resolve({ applied: true, outcome: { landed: [...plugins], refused: [] } });
        },
      },
      client: { getWorkingTreeStatesBeneath: (plugin) => client.getWorkingTreeStatesBeneath(plugin) },
      instance: instanceThatReads, reporter, ask,
    }, () => viewSelection);
    return { handler: present(handlers.get('modbench.plugin.decompileAndRepair'), 'the decompile and repair command'), reporter, repaired, ask, client };
  }

  const row = (plugin: PluginAddress) => new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);

  it('on a plugin row whose source is held, repairs it unforced asking nothing, under the view\'s progress, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    const { handler, reporter, repaired, ask } = registered([], [], client);

    await handler(row(MALFORMED));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: false }]);
    expect(ask.asked).toEqual([]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'decompile and repair', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled and repaired "Malformed.esp".']);
  });

  it('on a plugin row whose source has working-tree changes, asks naming it before any write, then repairs it forced', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', changedSource);
    const { handler, repaired, ask } = registered([], ['Decompile and repair'], client);

    await handler(row(MALFORMED));

    expect(ask.asked).toEqual([{
      message: 'Decompile and repair "Malformed.esp" in ModA? It replaces changes to its source that git does not hold.',
      detail: undefined,
      buttons: ['Decompile and repair'],
    }]);
    expect(repaired).toEqual([{ plugins: [MALFORMED], force: true }]);
  });

  it('from a Malformed entry\'s link in the Problems panel, repairs the plugin it names, not the selection', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getWorkingTreeStatesBeneath', clean);
    const { handler, repaired } = registered([row(SELECTED)], [], client);

    await handler(MALFORMED);

    expect(repaired.map(({ plugins }) => plugins)).toEqual([[MALFORMED]]);
  });

  it('for the agent, repairs the plugins given, forced when its options say force, asking nothing and reporting nothing, and answers the outcome', async () => {
    const { handler, reporter, repaired, ask } = registered([row(SELECTED)]);

    const answered = await handler(new AgentCall([{ kind: 'plugin', plugin: MALFORMED }], { force: true }));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: true }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [] } });
    expect(ask.asked).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('tells the user a plugin mEdit refused, naming why', async () => {
    const reporter = recordingReporter();
    const reason = 'Malformed.esp is not malformed.';
    registerDecompileAndRepairCommand({
      commands: { decompileAndRepair: () => Promise.resolve({ applied: true, outcome: { landed: [], refused: [{ item: MALFORMED, reason }] } }) },
      client: { getWorkingTreeStatesBeneath: () => Promise.resolve(clean) },
      instance: instanceThatReads, reporter, ask: scriptedDialog(),
    }, () => []);

    await present(handlers.get('modbench.plugin.decompileAndRepair'), 'the decompile and repair command')(row(MALFORMED));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not decompile and repair "Malformed.esp".', detail: `"Malformed.esp (ModA)" (${reason})` }]);
  });
});
