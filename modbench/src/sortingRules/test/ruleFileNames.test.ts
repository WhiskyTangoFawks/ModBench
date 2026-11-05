import { describe, expect, it } from 'vitest';
import { ruleFilePluginNames } from '../ruleFileNames';

const TEXT = `groups:
  - name: 'A.esp group'
plugins:
  - name: 'A.esp'
    after: [ B.esp, { name: "C.esp", display: 'C' } ]
    req:
      - D.esp
    inc: [ 'Other.*\\.esp' ]
    group: 'A.esp group'
  - name: 'Patch.*\\.esp'
    after: [ A.esp ]
`;

function named(text: string) {
  const names = ruleFilePluginNames(text);
  return 'refused' in names ? names : names.map(({ name, start, end }) => [name, text.slice(start, end)]);
}

describe('the plugins a sorting rule file names (ADR-0026)', () => {
  it('are each entry\'s name and each plugin its after, req and inc name, with the span of each name', () => {
    expect(named(TEXT)).toEqual([
      ['A.esp', 'A.esp'], ['B.esp', 'B.esp'], ['C.esp', 'C.esp'], ['D.esp', 'D.esp'], ['A.esp', 'A.esp'],
    ]);
  });

  it('are refused, saying why, for a file that does not read', () => {
    expect(ruleFilePluginNames('plugins: [')).toEqual({ refused: expect.stringContaining('line 1') as unknown });
  });
});
