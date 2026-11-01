import type { BrokenRule } from './judge';
import type { RuleFileProblem, RuleLevel, SortingRuleFiles } from './lootMetadata';

/** A line of a sorting rule file that the Problems panel shows. */
export interface RuleFileDiagnostic {
  path: string;
  line: number;
  level: RuleLevel;
  text: string;
}

/** What a sorting rule file says of itself: a part that does not read, at Error, and each broken rule the userlist
 *  states, at its level, on the line that states it. */
export function ruleFileDiagnostics(
  files: SortingRuleFiles, problems: readonly RuleFileProblem[], broken: readonly BrokenRule[],
): RuleFileDiagnostic[] {
  return [
    ...problems.map(({ file, line = 0, text }): RuleFileDiagnostic => ({ path: files[file].path, line, level: 'error', text })),
    ...broken.flatMap(({ source, level, reason }): RuleFileDiagnostic[] => (source?.file === 'userlist'
      ? [{ path: files.userlist.path, line: source.line, level, text: reason }]
      : [])),
  ];
}
