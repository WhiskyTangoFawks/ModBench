import { describe, expect, it } from 'vitest';
import type { BrokenRule } from '../judge';
import { suggestedMove } from '../suggestedMove';

const ref = (filename: string) => ({ origin: 'Mod', filename });
const broken = (rule: BrokenRule['rule'], ...plugins: string[]): BrokenRule => ({ rule, level: 'warning', plugins: plugins.map(ref), reason: 'broken' });

describe('suggestedMove: the nearest place a plugin keeps the sorting rule it breaks', () => {
  it('moves the first plugin of a master rule directly above the second', () => {
    expect(suggestedMove(broken('master', 'A.esp', 'B.esp'))).toEqual({ mover: ref('A.esp'), side: 'before', anchor: ref('B.esp') });
  });

  it('moves the first plugin of a loadAfter rule directly below the second', () => {
    expect(suggestedMove(broken('loadAfter', 'A.esp', 'B.esp'))).toEqual({ mover: ref('A.esp'), side: 'after', anchor: ref('B.esp') });
  });

  it.each(['group', 'gameMoves'] as const)('moves the one plugin of a %s rule where its placement says', (rule) => {
    const withPlacement: BrokenRule = { ...broken(rule, 'A.esp'), placement: { side: 'after', anchor: ref('B.esp') } };

    expect(suggestedMove(withPlacement)).toEqual({ mover: ref('A.esp'), side: 'after', anchor: ref('B.esp') });
  });

  it.each(['missingMaster', 'requirement', 'incompatibility', 'message', 'condition'] as const)('offers no move for %s, which no move keeps', (rule) => {
    expect(suggestedMove(broken(rule, 'A.esp'))).toBeUndefined();
  });
});
