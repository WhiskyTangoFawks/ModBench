import type { ReadRules, RuleFileName } from '../sortingRules/lootMetadata';

const NO_MASTERLIST = "No masterlist in the instance: update masterlist fetches the game's. The game's sorting rules and the userlist's still apply.";

/** What the Plugins view says of the sorting rule files, a line each: no masterlist, and each file that does not read. */
export function sortingRuleFileLines({ files, problems }: ReadRules): string[] {
  const named = (['masterlist', 'prelude', 'userlist'] as const satisfies readonly RuleFileName[]).flatMap((file) => {
    const problem = problems.find((candidate) => candidate.file === file);
    if (problem === undefined) return [];
    const where = problem.line === undefined ? '' : ` (line ${problem.line + 1})`;
    return [`The ${file} does not read${where}: ${problem.text} The rules that read still apply.`];
  });
  return files.masterlist.kind === 'absent' ? [NO_MASTERLIST, ...named] : named;
}
