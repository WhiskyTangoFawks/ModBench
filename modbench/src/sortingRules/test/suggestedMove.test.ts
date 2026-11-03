import { describe, expect, it } from 'vitest';
import type { BrokenRule } from '../judge';
import { suggestedMove } from '../suggestedMove';

const ref = (filename: string) => ({ origin: 'Mod', filename });
const broken = (rule: BrokenRule['rule'], ...plugins: string[]): BrokenRule => ({ rule, level: 'warning', plugins: plugins.map(ref), reason: 'broken' });

describe('suggestedMove: the nearest place a plugin keeps the sorting rule it breaks', () => {
  it.each(['master', 'masterFlag'] as const)('moves the first plugin of a %s rule directly above the second', (rule) => {
    expect(suggestedMove(broken(rule, 'A.esp', 'B.esp'))).toEqual({ mover: ref('A.esp'), side: 'before', anchor: ref('B.esp') });
  });

  it.each(['blueprint', 'loadAfter', 'group'] as const)('moves the first plugin of a %s rule directly below the second', (rule) => {
    expect(suggestedMove(broken(rule, 'A.esp', 'B.esp'))).toEqual({ mover: ref('A.esp'), side: 'after', anchor: ref('B.esp') });
  });

  it.each(['missingMaster', 'requirement', 'incompatibility', 'message', 'condition'] as const)('offers no move for %s, which no move keeps', (rule) => {
    expect(suggestedMove(broken(rule, 'A.esp'))).toBeUndefined();
  });
});
