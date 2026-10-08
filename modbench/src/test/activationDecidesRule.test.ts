import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { ACTIVATION_DECIDES_MESSAGE, ACTIVATION_DECIDES_SELECTORS } from '../../eslint-rules/activationDecides.mjs';

function decisionsIn(code: string): Linter.LintMessage[] {
  const rule = ACTIVATION_DECIDES_SELECTORS.map((selector) => ({ selector, message: ACTIVATION_DECIDES_MESSAGE }));
  return new Linter().verify(code, { rules: { 'no-restricted-syntax': ['error', ...rule] } });
}

describe('the deciding selectors', () => {
  it.each([
    ['a loop written as forEach', 'disposables.forEach((d) => d.dispose());'],
    ['a branch written as optional chaining', 'client?.stop();'],
    ['an optional call', 'stop?.();'],
    ['an if', 'if (a) b();'],
  ])('flag %s', (_name, code) => {
    expect(decisionsIn(code).map((m) => m.message)).toContain(ACTIVATION_DECIDES_MESSAGE);
  });

  it('pass construction and registration', () => {
    expect(decisionsIn('const view = own(new View({ client }));')).toEqual([]);
  });
});
