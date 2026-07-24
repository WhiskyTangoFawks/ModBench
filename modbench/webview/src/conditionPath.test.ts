import { describe, it, expect } from 'vitest';
import { conditionFieldPath, conditionParamPath } from './conditionPath';

describe('conditionFieldPath', () => {
  it('builds the CTDA\\field\\index\\subField wire path', () => {
    expect(conditionFieldPath('Conditions', 0, 'Operator')).toBe('CTDA\\Conditions\\0\\Operator');
  });
});

describe('conditionParamPath', () => {
  it('builds the Parameter\\n sub-field path', () => {
    expect(conditionParamPath('Conditions', 2, 1)).toBe('CTDA\\Conditions\\2\\Parameter\\1');
  });
});
