import type { Deployed } from '../deployment/deployment';

export interface DeployProblem {
  readonly message: string;
  readonly detail: string;
  /** The game gets something the load order does not hold (deployment-hardlink.md, Deploy, story 8). */
  readonly failsTask: boolean;
}

const named = (files: readonly { path: string; winner: string }[]): string => files.map(({ path, winner }) => `${winner} at ${path}`).join(', ');

export const UNMANAGED_MESSAGE = 'The deployment folder holds files deploy does not manage:';

/** What a landed deploy tells besides the files it does not manage, in the order it is told. */
export function deployProblems(result: Deployed): DeployProblem[] {
  const problems: DeployProblem[] = [];
  if (result.leftOut.length > 0) {
    problems.push({ message: 'Deploy left out each file whose path holds a file it did not write:', detail: named(result.leftOut), failsTask: true });
  }
  if (result.lost.length > 0) {
    problems.push({ message: 'Deploy left out each file whose path another file the game gets wins:', detail: named(result.lost), failsTask: true });
  }
  if (result.pluginsTxt.kind === 'notWritten') {
    problems.push({ message: 'Deploy wrote no plugins.txt:', detail: result.pluginsTxt.why, failsTask: true });
  } else if (result.pluginsTxt.renamed.length > 0) {
    problems.push({
      message: 'Deploy renamed each plugins.txt it did not write, so the game reads the plugin order of this load order:',
      detail: result.pluginsTxt.renamed.join(', '), failsTask: false,
    });
  }
  if (result.leftAside.length > 0) {
    problems.push({ message: 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:', detail: result.leftAside.join(', '), failsTask: false });
  }
  return problems;
}
