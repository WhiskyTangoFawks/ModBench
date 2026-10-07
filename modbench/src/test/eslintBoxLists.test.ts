import { describe, it, expect } from 'vitest';
import { BOXES as LINT_BOXES, DRIVING_BOXES as LINT_DRIVING_BOXES } from '../../eslint-rules/boxes.mjs';
import { BOXES, DRIVING_BOXES } from './boxes';

describe('the lint config names the boxes the zoom-out draws', () => {
  it('every box', () => {
    expect([...LINT_BOXES].sort()).toEqual([...BOXES].sort());
  });

  it('the driving boxes', () => {
    expect([...LINT_DRIVING_BOXES].sort()).toEqual([...DRIVING_BOXES].sort());
  });
});
