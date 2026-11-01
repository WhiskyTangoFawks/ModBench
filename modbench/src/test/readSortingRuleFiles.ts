import type { SortingRuleFiles } from '../instanceAdapter/instanceAdapter';

/** Sorting rule files that read and hold no rule: a masterlist is there. */
export const READ_SORTING_RULE_FILES: SortingRuleFiles = {
  masterlist: { path: '/instance/masterlist.yaml', kind: 'text', text: 'plugins: []\n' },
  prelude: { path: '/instance/prelude.yaml', kind: 'absent' },
  userlist: { path: '/instance/userlist.yaml', kind: 'absent' },
};
