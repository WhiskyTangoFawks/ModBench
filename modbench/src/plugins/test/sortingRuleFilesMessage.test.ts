import { describe, expect, it } from 'vitest';
import { rulesReader, type SortingRuleFiles } from '../../sortingRules/lootMetadata';
import { sortingRuleFilesMessage } from '../sortingRuleFilesMessage';

type SortingRuleFile = SortingRuleFiles['masterlist'];
const text = (body: string): SortingRuleFile => ({ path: '/i/f.yaml', kind: 'text', text: body });
const absent: SortingRuleFile = { path: '/i/f.yaml', kind: 'absent' };
const messageOf = (parts: { masterlist?: SortingRuleFile; userlist?: SortingRuleFile }) =>
  sortingRuleFilesMessage(rulesReader()({ masterlist: text('plugins: []\n'), prelude: absent, userlist: absent, ...parts }));

describe('sortingRuleFilesMessage', () => {
  it('says nothing while the masterlist and userlist read', () => {
    expect(messageOf({})).toBeUndefined();
  });

  it('says there is no masterlist, naming update masterlist, and that the other rules still apply', () => {
    expect(messageOf({ masterlist: absent })).toMatch(/No masterlist.*update masterlist.*still apply/);
  });

  it('names a file that does not read, with its line', () => {
    expect(messageOf({ userlist: text('plugins:\n  - name: A.esp\n    inc: [\n') })).toMatch(/^The userlist does not read \(line \d+\): .* The rules that read still apply\.$/);
  });

  it('names a file that could not be read', () => {
    expect(messageOf({ userlist: { path: '/i/userlist.yaml', kind: 'unreadable', reason: 'EACCES' } })).toBe('The userlist does not read: EACCES The rules that read still apply.');
  });
});
