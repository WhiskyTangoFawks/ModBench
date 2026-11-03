import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  CodeAction: class { command?: unknown; constructor(readonly title: string, readonly kind: unknown) {} },
  CodeActionKind: { QuickFix: 'quickfix' },
}));

import type { OfferedMove } from '../../pluginCommands/pluginOrder';
import type { RuleSource } from '../../sortingRules/lootMetadata';
import { suggestedMoveActions } from '../suggestedMoveActions';

const USERLIST = '/instance/loot/userlist.yaml';

const offer = (name: string, source: RuleSource | undefined): OfferedMove => ({
  rule: { rule: 'loadAfter', level: 'warning', plugins: [], reason: `${name} loads after`, source },
  mover: { origin: 'Mod', filename: name },
  drop: { kind: 'after', name: 'Z.esp' },
});

const actionsAt = (moves: OfferedMove[], path: string, line: number) => {
  const provider = suggestedMoveActions({ userlistPath: () => USERLIST, moves: () => moves });
  return provider.provideCodeActions({ uri: { fsPath: path } }, { start: { line }, end: { line } });
};

describe('suggestedMoveActions: apply suggested move on a rule\'s line in the userlist', () => {
  const stated = offer('A.esp', { file: 'userlist', line: 4 });

  it('offers the move of the rule the line states, handing the command the move chosen', () => {
    const [action, ...more] = actionsAt([stated, offer('B.esp', { file: 'userlist', line: 9 })], USERLIST, 4);

    expect(more).toEqual([]);
    expect(action?.title).toBe('Apply suggested move: A.esp loads after');
    expect(action?.command).toEqual({
      command: 'modbench.plugin.applySuggestedMove', title: 'Apply suggested move',
      arguments: [undefined, undefined, { plugin: { name: 'A.esp', origin: 'Mod' }, drop: { kind: 'after', name: 'Z.esp' } }],
    });
  });

  it('offers nothing on another line', () => {
    expect(actionsAt([stated], USERLIST, 5)).toEqual([]);
  });

  it('offers nothing in another file', () => {
    expect(actionsAt([stated], '/instance/loot/other.yaml', 4)).toEqual([]);
  });

  it.each<[string, RuleSource | undefined]>([
    ['the masterlist', { file: 'masterlist', line: 4 }],
    ['the game', undefined],
  ])('offers nothing for a rule %s states', (_, source) => {
    expect(actionsAt([offer('A.esp', source)], USERLIST, 4)).toEqual([]);
  });
});
