import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, picks } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    picks: { label: undefined as string | undefined, offered: [] as string[] },
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri } from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: {
      withProgress: recordedWithProgress,
      showQuickPick: (items: { label: string }[]) => {
        picks.offered = items.map(({ label }) => label);
        return Promise.resolve(items.find(({ label }) => label === picks.label));
      },
    },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri,
  };
});

import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import type { OfferedMove } from '../../pluginCommands/pluginOrder';
import type { BrokenRule } from '../../sortingRules/judge';
import { registerApplySuggestedMoveCommand } from '../applySuggestedMoveCommand';
import { PluginNode } from '../pluginRows';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { progressSteps } from '../../test/recordedProgress';

const APPLY = 'modbench.plugin.applySuggestedMove';
const A = { name: 'A.esp', origin: 'ModA' };

const offer = (reason: string, anchor: string, side: 'before' | 'after'): OfferedMove => ({
  rule: { rule: 'loadAfter', level: 'warning', plugins: [], reason } satisfies BrokenRule,
  mover: { origin: A.origin, filename: A.name },
  drop: { kind: side, name: anchor },
});
const AFTER_C = offer('A loads after C', 'C.esp', 'after');
const BEFORE_B = offer('A loads before B', 'C.esp', 'before');

const invoke = (...args: unknown[]) => Promise.resolve(present(handlers.get(APPLY), 'the apply suggested move command')(...args));
const rowOfA = () => new PluginNode({ name: A.name, enabled: true }, A.origin);
const moved = (toIndex: number) => [{ verb: 'changePluginOrderOverProvided', profile: 'Default', changes: [{ kind: 'move', plugins: [A.name], toIndex }] }];

function registered(offers: readonly OfferedMove[]) {
  const reporter = recordingReporter();
  const fake = fakeInstanceAdapter(readingFixture({ pluginOrder: ['A.esp', 'B.esp', 'C.esp'].map((name) => ({ name, enabled: true })) }));
  const instance = { value: instanceValueFixture({ activeProfile: 'Default' }), refresh: () => Promise.resolve() };
  registerApplySuggestedMoveCommand(
    { commands: pluginCommandsWith(fake.adapter, { getPlugins: () => Promise.resolve([]) }), instance, reporter, movesOf: () => offers },
    () => [],
  );
  return { reporter, fake };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  picks.label = undefined;
  picks.offered = [];
});

describe('modbench.plugin.applySuggestedMove', () => {
  it('moves the plugin with no prompt when one broken rule offers a move', async () => {
    const { reporter, fake } = registered([AFTER_C]);

    await invoke(rowOfA());

    expect(picks.offered).toEqual([]);
    expect(fake.calls).toEqual(moved(2));
    expect(reporter.reports).toEqual([]);
  });

  it('picks among the broken rules when more than one offers a move, and applies the one picked', async () => {
    const { fake } = registered([AFTER_C, BEFORE_B]);
    picks.label = 'A loads before B';

    await invoke(rowOfA());

    expect(picks.offered).toEqual(['A loads after C', 'A loads before B']);
    expect(fake.calls).toEqual(moved(1));
  });

  it('moves nothing when the pick is dismissed', async () => {
    const { reporter, fake } = registered([AFTER_C, BEFORE_B]);

    await invoke(rowOfA());

    expect(fake.calls).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('applies the move a code action hands it, whatever the view selects', async () => {
    const { fake } = registered([]);

    await invoke(undefined, undefined, { plugin: A, drop: AFTER_C.drop });

    expect(fake.calls).toEqual(moved(2));
  });

  it('says so when the plugin has no move to apply', async () => {
    const { reporter, fake } = registered([]);

    await invoke(rowOfA());

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'No suggested move for "A.esp".', detail: undefined }]);
    expect(fake.calls).toEqual([]);
  });
});

describe('modbench.plugin.applySuggestedMove, called by the agent', () => {
  const call = (options: { rule?: string }, plugin = A) => new AgentCall([{ kind: 'plugin', plugin }], options);

  it('names the broken rule by its words, and answers the outcome', async () => {
    const { fake } = registered([AFTER_C, BEFORE_B]);

    const answered = await invoke(call({ rule: 'A loads before B' }));

    expect(fake.calls).toEqual(moved(1));
    expect(answered).toEqual({ applied: true, outcome: { landed: [A], refused: [] } });
  });

  it('needs no rule when only one offers a move', async () => {
    const { fake } = registered([AFTER_C]);

    await invoke(call({}));

    expect(fake.calls).toEqual(moved(2));
  });

  it('refuses a call that leaves the rule out when several offer a move, writing nothing', async () => {
    const { fake } = registered([AFTER_C, BEFORE_B]);

    await expect(invoke(call({}))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });

  it('refuses a rule that offers no move, writing nothing', async () => {
    const { fake } = registered([AFTER_C]);

    await expect(invoke(call({ rule: 'something else' }))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
