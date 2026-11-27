import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { indexedOver } from './pluginsOver';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { READ_SORTING_RULE_FILES } from '../../test/readSortingRuleFiles';

const APPLY = 'modbench.plugin.applySuggestedMove';
const USERLIST = '/instance/loot/userlist.yaml';
const NAMES = ['A.esp', 'B.esp', 'C.esp'];
const A = { name: 'A.esp', origin: 'ModA' };
const AFTER = (...names: string[]) => `plugins:\n  - name: 'A.esp'\n    after: [${names.map((name) => `'${name}'`).join(', ')}]\n`;

const moved = (toIndex: number) => [{ verb: 'changePluginOrderOverProvided', profile: 'Default', changes: [{ kind: 'move', plugins: [A.name], toIndex }] }];

async function suggesting(userlist: string | undefined, masterlist?: string) {
  const made = await indexedOver(NAMES, {
    value: {
      sortingRuleFiles: {
        ...READ_SORTING_RULE_FILES, ...userlist !== undefined && { userlist: { path: USERLIST, kind: 'text', text: userlist } },
        ...masterlist !== undefined && { masterlist: { path: '/instance/loot/masterlist.yaml', kind: 'text', text: masterlist } },
      },
    },
  });
  return { ...made, rowOfA: made.row(A.name), apply: (...args: unknown[]) => host.run(APPLY, ...args) };
}

const offered = () => host.quickPicks.map(({ items }) => items);

describe('modbench.plugin.applySuggestedMove', () => {
  it('moves the plugin with no prompt when one broken rule offers a move', async () => {
    const { fake, rowOfA, apply, reporter } = await suggesting(AFTER('C.esp'));

    await apply(rowOfA);

    expect([offered(), fake.calls, reporter('pluginListTree.applySuggestedMove').reports]).toEqual([[], moved(2), []]);
  });

  it('picks among the broken rules when more than one offers a move, and applies the one picked', async () => {
    const { fake, rowOfA, apply } = await suggesting(AFTER('B.esp', 'C.esp'));
    host.picks((labels) => labels[0]);

    await apply(rowOfA);

    expect([offered().map((labels) => labels.length), fake.calls]).toEqual([[2], moved(1)]);
  });

  it('moves nothing when the pick is dismissed', async () => {
    const { fake, rowOfA, apply, reporter } = await suggesting(AFTER('B.esp', 'C.esp'));

    await apply(rowOfA);

    expect([fake.calls, reporter('pluginListTree.applySuggestedMove').reports]).toEqual([[], []]);
  });

  it('applies the move a code action hands it, whatever the view selects', async () => {
    const { fake, apply } = await suggesting(undefined);

    await apply(undefined, undefined, { plugin: A, drop: { kind: 'after', name: 'C.esp' } });

    expect(fake.calls).toEqual(moved(2));
  });

  it('says so when the plugin has no move to apply', async () => {
    const { fake, rowOfA, apply, reporter } = await suggesting(undefined);

    await apply(rowOfA);

    expect([reporter('pluginListTree.applySuggestedMove').reports, fake.calls]).toEqual([[{ severity: 'error', message: 'No suggested move for "A.esp".', detail: undefined }], []]);
  });
});

describe('modbench.plugin.applySuggestedMove, called by the agent', () => {
  const call = (options: { rule?: string }) => new AgentCall([{ kind: 'plugin', plugin: A }], options);

  it('names the broken rule by its words, and answers the outcome', async () => {
    const { fake, apply } = await suggesting(AFTER('B.esp', 'C.esp'));

    const answered = await apply(call({ rule: '"A.esp" loads before "C.esp", and should load after it.' }));

    expect([fake.calls, answered]).toEqual([moved(2), { applied: true, outcome: { landed: [A], refused: [] } }]);
  });

  it('needs no rule when only one offers a move', async () => {
    const { fake, apply } = await suggesting(AFTER('C.esp'));

    await apply(call({}));

    expect(fake.calls).toEqual(moved(2));
  });

  it.each([
    ['leaves the rule out when several offer a move', AFTER('B.esp', 'C.esp'), {}],
    ['names a rule that offers no move', AFTER('C.esp'), { rule: 'something else' }],
  ])('refuses a call that %s, writing nothing', async (_, userlist, options) => {
    const { fake, apply } = await suggesting(userlist);

    await expect(apply(call(options))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});

describe('apply suggested move on a rule\'s line in the userlist', () => {
  it('offers the move of the rule the line states, handing the command the move chosen', async () => {
    await suggesting(`plugins:\n  - name: 'B.esp'\n    after: ['C.esp']\n  - name: 'A.esp'\n    after: ['C.esp']\n`);

    const actions = await host.codeActions(USERLIST, 4);

    expect(actions.map(({ title, command }) => [title, command])).toEqual([['Apply suggested move: "A.esp" loads before "C.esp", and should load after it.', {
      command: APPLY, title: 'Apply suggested move', arguments: [undefined, undefined, { plugin: A, drop: { kind: 'after', name: 'C.esp' } }],
    }]]);
  });

  it.each([
    ['on another line', USERLIST, 0],
    ['in another file', '/instance/loot/other.yaml', 2],
  ])('offers nothing %s', async (_, path, line) => {
    await suggesting(AFTER('C.esp'));

    expect(await host.codeActions(path, line)).toEqual([]);
  });

  it('offers nothing for a rule the masterlist states', async () => {
    await suggesting(undefined, AFTER('C.esp'));

    expect(await host.codeActions(USERLIST, 2)).toEqual([]);
  });
});
