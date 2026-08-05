import { describe, it, expect } from 'vitest';
import { defaultCondition } from './conditionOps';

describe('defaultCondition', () => {
  it('produces a sensible zero-parameter default', () => {
    const d = defaultCondition();
    expect(d.function).toBeTruthy();
    expect(d.operator).toBe('EqualTo');
    expect(d.comparisonFloat).toBe(0);
    expect(d.parameters).toEqual([]);
  });
});
