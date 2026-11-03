import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => ({
  Uri: (await import('../../test/vscodeMock')).Uri,
  CodeAction: class { command?: unknown; constructor(readonly title: string, readonly kind: unknown) {} },
  CodeActionKind: { QuickFix: 'quickfix' },
}));

import { Uri } from '../../test/vscodeMock';
import type { OfferedMove } from '../../pluginCommands/pluginOrder';
import type { RuleSource } from '../../sortingRules/lootMetadata';
import { suggestedMoveActions } from '../suggestedMoveActions';

const USERLIST = '/instance/loot/userlist.yaml';

const offer = (name: string, source: RuleSource | undefined): OfferedMove => ({
  rule: { rule: 'loadAfter', level: 'warning', plugins: [], reason: `${name} loads after`, source },
  mover: { origin: 'Mod', name },
  drop: { kind: 'after', name: 'Z.esp' },
});

const actionsAt = (moves: OfferedMove[], path: string, line: number) => {
  const provider = suggestedMoveActions({ userlistPath: () => USERLIST, moves: () => moves });
  return provider.provideCodeActions({ uri: Uri.file(path) }, { start: { line }, end: { line } });
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

  it.each<[string, OfferedMove[], string, number]>([
    ['on another line', [stated], USERLIST, 5],
    ['in another file', [stated], '/instance/loot/other.yaml', 4],
    ['for a rule the masterlist states', [offer('A.esp', { file: 'masterlist', line: 4 })], USERLIST, 4],
    ['for a rule the game states', [offer('A.esp', undefined)], USERLIST, 4],
  ])('offers nothing %s', (_, moves, path, line) => {
    expect(actionsAt(moves, path, line)).toEqual([]);
  });
});
