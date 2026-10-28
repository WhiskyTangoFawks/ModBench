import type * as vscode from 'vscode';
import { registerTaskGesture, type TaskVerdict } from '../drivingLib/taskGesture';
import type { Reporter } from '../ports/reporter';
import type { DeployResult } from '../instanceCommands/deploy';
import { UNMANAGED_MESSAGE, deployProblems, type DeployProblem } from './deployProblems';

/** deployment-hardlink.md, Deploy, story 8. */
export function registerDeployTask(reporter: Reporter): vscode.Disposable {
  return registerTaskGesture<DeployResult>({ label: 'Deploy', command: 'modbench.instance.deploy', reporter, argument: () => [], settle: deployVerdict });
}

function deployVerdict(result: DeployResult): TaskVerdict {
  if (!result.applied) return { passed: false, lines: [], problems: [{ severity: 'error', message: 'Could not deploy.', detail: result.refusal }] };
  const unmanaged: DeployProblem[] = result.unmanaged.length === 0 ? [] : [{ message: UNMANAGED_MESSAGE, detail: result.unmanaged.join(', '), failsTask: false }];
  const found = [...deployProblems(result), ...unmanaged];
  return {
    passed: !found.some(({ failsTask }) => failsTask),
    lines: [],
    problems: found.map(({ message, detail, failsTask }) => ({ severity: failsTask ? 'error' : 'warning', message, detail })),
  };
}
