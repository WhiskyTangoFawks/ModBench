import { messageLine } from '../drivingLib/messageLine';
import type { ReadRules, RuleFileName } from '../sortingRules/lootMetadata';

const NO_MASTERLIST = "No masterlist in the instance: update masterlist fetches the game's. The game's sorting rules and the userlist's still apply.";

function noMasterlistMessage({ files }: ReadRules): string | undefined {
  return files.masterlist.kind === 'absent' ? NO_MASTERLIST : undefined;
}

export function unreadRuleFilesMessage({ problems }: ReadRules): string | undefined {
  const named = (['masterlist', 'prelude', 'userlist'] as const satisfies readonly RuleFileName[]).flatMap((file) => {
    const problem = problems.find((candidate) => candidate.file === file);
    if (problem === undefined) return [];
    const where = problem.line === undefined ? '' : ` (line ${problem.line + 1})`;
    return [`The ${file} does not read${where}: ${problem.text} The rules that read still apply.`];
  });
  return messageLine(...named);
}

/** The Plugins view's message line for the sorting rule files: no masterlist, and each file that does not read. */
export function sortingRuleFilesMessage(rules: ReadRules): string | undefined {
  return messageLine(noMasterlistMessage(rules), unreadRuleFilesMessage(rules));
}
