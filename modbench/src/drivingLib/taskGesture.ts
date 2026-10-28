import * as vscode from 'vscode';
import type { Argument } from '../wire/argument';
import { errorMessage } from '../ports/errorMessage';
import { AgentCall } from './agentGesture';

/** What a task writes of a command's outcome, and whether the task succeeded: a task that did not fails the chain it is in. */
export interface TaskVerdict {
  readonly passed: boolean;
  readonly lines: readonly string[];
}

export interface TaskGesture<Outcome> {
  /** A `taskDefinitions` type in package.json. */
  readonly type: string;
  readonly label: string;
  readonly command: string;
  /** The Argument the task's definition supplies. */
  readonly argument: (definition: vscode.TaskDefinition) => readonly Argument[];
  readonly settle: (outcome: Outcome) => TaskVerdict;
}

/** commands.md, A task is an entry point for a chain. VS Code runs a dependent task only after exit code 0,
 *  so the terminal closes with an explicit code. */
export function registerTaskGesture<Outcome>(gesture: TaskGesture<Outcome>): vscode.Disposable {
  const taskFor = (definition: vscode.TaskDefinition): vscode.Task => new vscode.Task(
    definition, vscode.TaskScope.Workspace, gesture.label, 'modbench',
    new vscode.CustomExecution(() => Promise.resolve(terminalOf(gesture, definition))),
  );
  return vscode.tasks.registerTaskProvider(gesture.type, {
    provideTasks: () => [taskFor({ type: gesture.type })],
    resolveTask: (task) => taskFor(task.definition),
  });
}

function terminalOf<Outcome>(gesture: TaskGesture<Outcome>, definition: vscode.TaskDefinition): vscode.Pseudoterminal {
  const written = new vscode.EventEmitter<string>();
  const closed = new vscode.EventEmitter<number>();
  const finish = (verdict: TaskVerdict): void => {
    for (const line of verdict.lines) written.fire(`${line}\r\n`);
    closed.fire(verdict.passed ? 0 : 1);
  };
  return {
    onDidWrite: written.event,
    onDidClose: closed.event,
    open: () => {
      void (async () => {
        try {
          const outcome = await vscode.commands.executeCommand<Outcome>(gesture.command, new AgentCall(gesture.argument(definition), {}));
          finish(gesture.settle(outcome));
        } catch (e) {
          finish({ passed: false, lines: [errorMessage(e)] });
        }
      })();
    },
    close: () => undefined,
  };
}
