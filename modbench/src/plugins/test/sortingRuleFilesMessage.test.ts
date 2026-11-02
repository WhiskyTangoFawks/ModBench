import { describe, expect, it } from 'vitest';
import { rulesReader, type SortingRuleFiles } from '../../sortingRules/lootMetadata';
import { sortingRuleFileLines } from '../sortingRuleFilesMessage';

type SortingRuleFile = SortingRuleFiles['masterlist'];
const text = (body: string): SortingRuleFile => ({ path: '/i/f.yaml', kind: 'text', text: body });
const absent: SortingRuleFile = { path: '/i/f.yaml', kind: 'absent' };
const linesOf = (parts: { masterlist?: SortingRuleFile; userlist?: SortingRuleFile }) =>
  sortingRuleFileLines(rulesReader()({ masterlist: text('plugins: []\n'), prelude: absent, userlist: absent, ...parts }));

describe('sortingRuleFileLines', () => {
  it('says nothing while the masterlist and userlist read', () => {
    expect(linesOf({})).toEqual([]);
  });

  it('says there is no masterlist, naming update masterlist, and that the other rules still apply', () => {
    expect(linesOf({ masterlist: absent })).toEqual([expect.stringMatching(/No masterlist.*update masterlist.*still apply/)]);
  });

  it('names a file that does not read, with its line', () => {
    expect(linesOf({ userlist: text('plugins:\n  - name: A.esp\n    inc: [\n') })).toEqual([expect.stringMatching(/^The userlist does not read \(line \d+\): .* The rules that read still apply\.$/)]);
  });

  it('names a file that could not be read', () => {
    expect(linesOf({ userlist: { path: '/i/userlist.yaml', kind: 'unreadable', reason: 'EACCES' } })).toEqual(['The userlist does not read: EACCES The rules that read still apply.']);
  });
});
