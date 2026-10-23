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

import { registerDecompileAndRepairCommand, registerDecompileCommand } from '../pluginRowCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { PluginNode } from '../pluginRows';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
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
  const PREVIEW = {
    plugin: MALFORMED, hash: 'abc',
    diagnoses: [{ diagnosis: { anchor: 'REGN 00000800', defectClass: 'short', message: 'RDAT is 6 bytes' }, change: { description: 'pads RDAT', droppedBytes: 0 } }],
  };

  const DROPPING = { ...PREVIEW, diagnoses: [{ ...PREVIEW.diagnoses[0]!, change: { description: 'drops 25 bytes', droppedBytes: 25 } }] };

  function registered(viewSelection: readonly PluginNode[] = [], answers: readonly (string | undefined)[] = []) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...answers);
    const logged: string[] = [];
    const repaired: { plugins: readonly { name: string; origin: string }[]; force: boolean }[] = [];
    registerDecompileAndRepairCommand({
      commands: {
        decompileAndRepair: async (plugins, force, previewed, agrees) => {
          progressSteps.push('decompile and repair');
          repaired.push({ plugins, force });
          const preview = { ...DROPPING, plugin: present(plugins[0], 'a plugin to repair') };
          previewed(preview);
          if (!force && agrees && !await agrees([preview])) return { applied: true, outcome: { landed: [], refused: [] } };
          return { applied: true, outcome: { landed: [...plugins], refused: [] } };
        },
      },
      instance: instanceThatReads, reporter, ask, log: (line) => logged.push(line),
    }, () => viewSelection);
    return { handler: present(handlers.get('modbench.plugin.decompileAndRepair'), 'the decompile and repair command'), reporter, logged, repaired, ask };
  }

  const row = (plugin: { name: string; origin: string }) => new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);

  it('on a plugin row, names each previewed change in the Output, repairs it under the view\'s progress once the user agrees to what it drops, and lands once', async () => {
    const { handler, reporter, logged, repaired, ask } = registered([], ['Repair']);

    await handler(row(MALFORMED));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: false }]);
    expect(logged).toEqual(['Malformed.esp: REGN 00000800: drops 25 bytes']);
    expect(ask.asked).toEqual([{
      message: 'Repair drops data? Nothing is written until you agree.',
      detail: 'Malformed.esp: REGN 00000800: drops 25 bytes', buttons: ['Repair'],
    }]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'decompile and repair', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled and repaired "Malformed.esp".']);
  });

  it('tells the user a plugin whose bytes changed since the preview was refused', async () => {
    const reporter = recordingReporter();
    const reason = 'Malformed.esp\'s bytes changed since the repair preview, so nothing was written.';
    registerDecompileAndRepairCommand({
      commands: { decompileAndRepair: () => Promise.resolve({ applied: true, outcome: { landed: [], refused: [{ item: MALFORMED, reason }] } }) },
      instance: instanceThatReads, reporter, ask: scriptedDialog(), log: () => undefined,
    }, () => []);

    await present(handlers.get('modbench.plugin.decompileAndRepair'), 'the decompile and repair command')(row(MALFORMED));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not decompile and repair "Malformed.esp".', detail: `"Malformed.esp (ModA)" (${reason})` }]);
  });

  it('writes and says nothing when the user dismisses the question', async () => {
    const { handler, reporter } = registered([], [undefined]);

    await handler(row(MALFORMED));

    expect(reporter.landings).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('from a Malformed entry\'s link in the Problems panel, repairs the plugin it names, not the selection', async () => {
    const { handler, repaired } = registered([row(SELECTED)], ['Repair']);

    await handler(MALFORMED);

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: false }]);
  });

  it('for the agent, repairs the plugins given, forced when its options say force, asking nothing and reporting nothing, and answers the outcome', async () => {
    const { handler, reporter, repaired, ask } = registered([row(SELECTED)]);

    const answered = await handler(new AgentCall([{ kind: 'plugin', plugin: MALFORMED }], { force: true }));

    expect(repaired).toEqual([{ plugins: [MALFORMED], force: true }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [] } });
    expect(ask.asked).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });
});

