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
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
    Diagnostic, DiagnosticSeverity, Range,
    Uri: { file: uriFile, from: uriFrom },
  };
});

import { progressSteps } from '../../test/recordedProgress';

const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

import { registerDecompileCommand } from '../pluginRowCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { PluginNode } from '../pluginRows';
import { AgentCall } from '../../drivingLib/agentGesture';
import { assertAskedOnce, recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

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
          progressSteps.push('decompile');
          return client.decompile(plugins, force);
        },
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

  it('on a plugin row, asks once naming it, then decompiles it, the view\'s progress bar closing once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');

    await handler(row(SECOND));

    assertAskedOnce(ask, { messageContains: '"Second.esp"', buttons: ['Decompile'] });
    expect(ask.asked[0]?.message).toContain('replaces its source in the working tree from its bytes');
    expect(decompileCalls(client)).toEqual([[[SECOND], true]]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'decompile', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a selection, asks once naming every plugin, and decompiles them in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [FIRST, SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile 2 plugins? Decompile replaces their source in the working tree from their bytes.',
      detail: 'First.esp (ModA)\nSecond.esp (ModA)',
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST, SECOND], true]]);
    expect(reporter.landings).toEqual(['Decompiled 2 plugins.']);
  });

  it('decompiles nothing and says nothing when the confirmation is dismissed', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client, undefined);

    await handler(row(SECOND));

    expect(decompileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('from the palette, decompiles the Plugins view\'s selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [FIRST], refused: [] });
    const { handler } = registered(client, 'Decompile', [row(FIRST)]);

    await handler();

    expect(decompileCalls(client)).toEqual([[[FIRST], true]]);
  });

  it('names each refused plugin and why in one notification while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const refusal = 'First.esp does not round-trip through its own source.';
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
});

