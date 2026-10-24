import { describe, it, expect } from 'vitest';
import { selectionOutcomeOf, type CommandResult } from '../commandResult';

describe('selectionOutcomeOf', () => {
  it('lands each applied item and refuses each refused one by its reason', async () => {
    const results: Record<number, CommandResult> = {
      1: { applied: false, refusal: 'odd 1' },
      2: { applied: true, wrote: true },
      3: { applied: false, refusal: 'odd 3' },
    };
    const run = (n: number) => Promise.resolve(results[n]);
    expect(await selectionOutcomeOf([1, 2, 3], run, (n) => n)).toEqual({
      landed: [2],
      refused: [{ item: 1, reason: 'odd 1' }, { item: 3, reason: 'odd 3' }],
    });
  });

  it('hands a landed item its own result', async () => {
    const run = (): Promise<CommandResult<{ note: string }>> => Promise.resolve({ applied: true, note: 'left' });
    const outcome = await selectionOutcomeOf(['a'], run, (name, landed) => ({ name, note: landed?.note }));
    expect(outcome.landed).toEqual([{ name: 'a', note: 'left' }]);
  });

  it('builds a refused item without a result', async () => {
    const run = (): Promise<CommandResult<{ note: string }>> => Promise.resolve({ applied: false, refusal: 'no' });
    const outcome = await selectionOutcomeOf(['a'], run, (name, landed) => ({ name, note: landed?.note }));
    expect(outcome.refused).toEqual([{ item: { name: 'a', note: undefined }, reason: 'no' }]);
  });
});
