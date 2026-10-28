import type * as vscode from 'vscode';
import { registerTaskGesture, type TaskVerdict } from '../drivingLib/taskGesture';
import type { Reporter } from '../ports/reporter';
import type { DeployResult } from '../instanceCommands/deploy';
import { deployFailures, deployWarnings, unmanagedWarning } from './deployProblems';

/** deployment-hardlink.md, Deploy, story 8. */
export function registerDeployTask(reporter: Reporter): vscode.Disposable {
  return registerTaskGesture<DeployResult>({ label: 'Deploy', command: 'modbench.instance.deploy', reporter, argument: () => [], settle: deployVerdict });
}

function deployVerdict(result: DeployResult): TaskVerdict {
  if (!result.applied) return { passed: false, lines: [], problems: [{ severity: 'error', message: 'Could not deploy.', detail: result.refusal }] };
  const failures = deployFailures(result);
  const unmanaged = unmanagedWarning(result);
  return {
    passed: failures.length === 0,
    lines: [result.wrote ? 'Deployed the load order.' : 'The deployment folder already held the load order.'],
    problems: [
      ...failures.map((problem) => ({ severity: 'error' as const, ...problem })),
      ...(unmanaged === undefined ? [] : [{ severity: 'warning' as const, ...unmanaged }]),
      ...deployWarnings(result).map((problem) => ({ severity: 'warning' as const, ...problem })),
    ],
  };
}
