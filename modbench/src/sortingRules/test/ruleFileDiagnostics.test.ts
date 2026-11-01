import { describe, expect, it } from 'vitest';
import type { SortingRuleFiles } from '../lootMetadata';
import type { BrokenRule } from '../judge';
import { ruleFileDiagnostics } from '../ruleFileDiagnostics';

const files: SortingRuleFiles = {
  masterlist: { path: '/i/masterlist.yaml', kind: 'absent' }, prelude: { path: '/i/prelude.yaml', kind: 'absent' }, userlist: { path: '/i/userlist.yaml', kind: 'absent' },
};
const broken = (file: 'masterlist' | 'userlist', line: number): BrokenRule =>
  ({ rule: 'loadAfter', level: 'warning', plugins: [], reason: `from ${file}`, source: { file, line } });

describe('ruleFileDiagnostics', () => {
  it('shows a rule the userlist states on its line, and none the masterlist states', () => {
    expect(ruleFileDiagnostics(files, [], [broken('userlist', 4), broken('masterlist', 9)]))
      .toEqual([{ path: '/i/userlist.yaml', line: 4, level: 'warning', text: 'from userlist' }]);
  });

  it('shows a file that does not read at Error on its line, or the first line for a whole file', () => {
    expect(ruleFileDiagnostics(files, [{ file: 'masterlist', line: 7, text: 'bad' }, { file: 'userlist', text: 'EACCES' }], []))
      .toEqual([
        { path: '/i/masterlist.yaml', line: 7, level: 'error', text: 'bad' },
        { path: '/i/userlist.yaml', line: 0, level: 'error', text: 'EACCES' },
      ]);
  });
});
