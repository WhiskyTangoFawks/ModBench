import type { Deployed } from '../deployment/deployment';

export interface DeployProblem {
  readonly message: string;
  readonly detail: string;
}

const named = (files: readonly { path: string; winner: string }[]): string => files.map(({ path, winner }) => `${winner} at ${path}`).join(', ');

/** The game gets something the load order does not hold (deployment-hardlink.md, Deploy, story 8). */
export function deployFailures(result: Deployed): DeployProblem[] {
  const problems: DeployProblem[] = [];
  if (result.leftOut.length > 0) {
    problems.push({ message: 'Deploy left out each file whose path holds a file it did not write:', detail: named(result.leftOut) });
  }
  if (result.lost.length > 0) {
    problems.push({ message: 'Deploy left out each file whose path another file the game gets wins:', detail: named(result.lost) });
  }
  if (result.pluginsTxt.kind === 'notWritten') problems.push({ message: 'Deploy wrote no plugins.txt:', detail: result.pluginsTxt.why });
  return problems;
}

/** What a landed deploy says, and the game still gets the load order. */
export function deployWarnings(result: Deployed): DeployProblem[] {
  const problems: DeployProblem[] = [];
  if (result.pluginsTxt.kind !== 'notWritten' && result.pluginsTxt.renamed.length > 0) {
    problems.push({
      message: 'Deploy renamed each plugins.txt it did not write, so the game reads the plugin order of this load order:',
      detail: result.pluginsTxt.renamed.join(', '),
    });
  }
  if (result.leftAside.length > 0) {
    problems.push({ message: 'Deploy landed, and could not remove each file it set aside, which the next deploy removes:', detail: result.leftAside.join(', ') });
  }
  return problems;
}

export function unmanagedWarning({ unmanaged }: Pick<Deployed, 'unmanaged'>): DeployProblem | undefined {
  return unmanaged.length === 0 ? undefined : { message: 'The deployment folder holds files deploy does not manage:', detail: unmanaged.join(', ') };
}
