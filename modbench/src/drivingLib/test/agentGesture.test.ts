import { describe, it, expect, vi } from 'vitest';
import { TreeItem } from '../../test/vscodeMock';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { Argument } from '../../wire/argument';

const { registerCommand } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
}));

vi.mock('vscode', () => ({ commands: { registerCommand }, TreeItem }));

import { AgentCall, argumentOfKind, registerAgentGesture, reportPartial, type AgentGesture, type PartialFailure } from '../agentGesture';
import { Refusal } from '../refusal';
import type { GestureEntry } from '../gestureEntry';

class Row extends TreeItem {
  readonly kind = 'a';
}

const mod: Argument = { kind: 'mod', name: 'Alpha' };
const separator: Argument = { kind: 'separator', name: 'Sep' };
const folder: Argument = { kind: 'folder', path: '/f' };

describe('the Argument an agent call names, of the kind its gesture takes', () => {
  it.each([
    ['a mod for a mod gesture', mod, ['mod']],
    ['a separator for a mod-or-separator gesture', separator, ['mod', 'separator']],
    ['a mod for a mod-or-separator gesture', mod, ['mod', 'separator']],
  ] as const)('takes %s', (_name, argument, kinds) => {
    expect(argumentOfKind(argument, ...(kinds as readonly [Argument['kind'], ...Argument['kind'][]]))).toBe(argument);
  });

  it.each([
    [['mod'], 'An agent call to a mod gesture carries mods only, and this one carries a folder.'],
    [['mod', 'separator'], 'An agent call to a mod or separator gesture carries mod or separators only, and this one carries a folder.'],
  ] as const)('refuses a folder for kinds %j, naming the kind it carried', (kinds, message) => {
    expect(() => argumentOfKind(folder, ...(kinds as readonly [Argument['kind'], ...Argument['kind'][]]))).toThrow(new Refusal(message));
  });
});

describe('a gesture run as an agent call and as a view call', () => {
  const picked = new Row('Picked');
  const other = new Row('Other');

  function register(overrides: Partial<AgentGesture<Row, string, string>> = {}, isRow?: (value: unknown) => value is Row) {
    const reported: Array<[string, string]> = [];
    const entries: Array<GestureEntry<Row>> = [];
    const gesture: AgentGesture<Row, string, string> = {
      fromView: (entry, option) => { entries.push(entry); return `view:${String(option)}`; },
      fromAgent: (call) => `agent:${call.argument.length}`,
      run: (given) => Promise.resolve(`ran ${given}`),
      report: (outcome, given) => { reported.push([outcome, given]); },
      ...overrides,
    };
    const selection = [picked];
    const disposable = isRow
      ? registerAgentGesture('modbench.test.gesture', () => selection, gesture, isRow)
      : registerAgentGesture('modbench.test.gesture', () => selection, gesture);
    const registered = registerCommand.mock.calls.at(-1)?.[1];
    if (!registered) throw new Error('the gesture registered no command');
    const handler = (...args: unknown[]): Promise<unknown> => Promise.resolve(registered(...args));
    disposable.dispose();
    return { handler, reported, entries };
  }

  it('an agent call answers the outcome of what the agent gave, and reports nothing', async () => {
    const { handler, reported } = register();
    expect(await handler(new AgentCall([mod, separator], {}))).toBe('ran agent:2');
    expect(reported).toEqual([]);
  });

  it('a view call runs what the view gave and reports the outcome with it', async () => {
    const { handler, reported } = register();
    expect(await handler(other, [other], 'opt')).toBeUndefined();
    expect(reported).toEqual([['ran view:opt', 'view:opt']]);
  });

  it('a view call hands the view the clicked row and the option', async () => {
    const seen: unknown[] = [];
    const { handler } = register({ fromView: (_entry, option, clicked) => { seen.push(option, clicked); return undefined; } });
    await handler(other, [other, picked], 'opt');
    expect(seen).toEqual(['opt', other]);
  });

  it('a view call the view ends with nothing runs nothing', async () => {
    const run = vi.fn(() => Promise.resolve('x'));
    const { handler, reported } = register({ fromView: () => undefined, run });
    await handler();
    expect(run).not.toHaveBeenCalled();
    expect(reported).toEqual([]);
  });

  it('a view call from the palette takes the view selection as its entry', async () => {
    const { handler, entries } = register();
    await handler();
    expect(entries).toEqual([{ focused: picked, selection: [picked] }]);
  });

  it('with isRow, the gesture says which clicked values are rows', async () => {
    const context = { webview: 'ctx' };
    const { handler, entries } = register({}, (value): value is Row => value === context);
    await handler(context);
    expect(entries).toEqual([{ clicked: context, selection: [context] }]);
  });
});

describe('what a partly landed gesture tells the user', () => {
  const warning: PartialFailure = { message: 'Warned', detail: 'because', severity: 'warning' };
  const logged: PartialFailure = { message: 'Logged', detail: 'quietly', severity: 'log' };

  it('warns of a warning and logs a log, each with what and why', () => {
    const reporter = recordingReporter();
    const lines: string[] = [];
    reportPartial(reporter, [warning, logged], (line) => lines.push(line));
    expect(reporter.reports).toEqual([{ severity: 'warning', message: 'Warned', detail: 'because' }]);
    expect(lines).toEqual(['Logged: quietly']);
  });

  it('says nothing when nothing failed', () => {
    const reporter = recordingReporter();
    reportPartial(reporter);
    reportPartial(reporter, [logged]);
    expect(reporter.reports).toEqual([]);
  });
});
