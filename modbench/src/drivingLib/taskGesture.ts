import * as vscode from 'vscode';
import type { Argument } from '../wire/argument';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter, Severity } from '../ports/reporter';
import { AgentCall } from './agentGesture';

/** A refusal, a part that did not land whole, or a warning. The terminal carries it, and so does the Output (ADR-0019). */
export interface TaskProblem {
  readonly severity: Severity;
  readonly message: string;
  readonly detail?: string;
}

/** What a task writes of a command's outcome, and whether the task succeeded: a task that did not fails the chain it is in. */
export interface TaskVerdict {
  readonly passed: boolean;
  readonly lines: readonly string[];
  readonly problems: readonly TaskProblem[];
}

export interface TaskGesture<Outcome> {
  readonly label: string;
  /** The task's type is its gesture's Command ID (commands.md, One identity), declared in package.json's `taskDefinitions`. */
  readonly command: string;
  readonly reporter: Reporter;
  /** The Argument the task's definition supplies. */
  readonly argument: (definition: vscode.TaskDefinition) => readonly Argument[];
  readonly settle: (outcome: Outcome) => TaskVerdict;
}

/** commands.md, A task is an entry point for a chain. VS Code runs a dependent task only after exit code 0,
 *  so the terminal closes with an explicit code. */
export function registerTaskGesture<Outcome>(gesture: TaskGesture<Outcome>): vscode.Disposable {
  const taskFor = (definition: vscode.TaskDefinition, scope: vscode.Task['scope'] = vscode.TaskScope.Workspace): vscode.Task => new vscode.Task(
    definition, scope, gesture.label, 'modbench',
    new vscode.CustomExecution(() => Promise.resolve(terminalOf(gesture, definition))),
  );
  return vscode.tasks.registerTaskProvider(gesture.command, {
    provideTasks: () => [taskFor({ type: gesture.command })],
    resolveTask: ({ definition, scope }) => taskFor(definition, scope),
  });
}

const textOf = ({ message, detail }: TaskProblem): string => (detail === undefined ? message : `${message} ${detail}`);

function terminalOf<Outcome>(gesture: TaskGesture<Outcome>, definition: vscode.TaskDefinition): vscode.Pseudoterminal {
  const written = new vscode.EventEmitter<string>();
  const closed = new vscode.EventEmitter<number>();
  const finish = (verdict: TaskVerdict): void => {
    for (const { severity, message, detail } of verdict.problems) gesture.reporter.shownOnSurface(severity, message, detail);
    for (const line of [...verdict.problems.map(textOf), ...verdict.lines]) written.fire(`${line}\r\n`);
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
          finish({ passed: false, lines: [], problems: [{ severity: 'error', message: errorMessage(e) }] });
        }
      })();
    },
    close: () => undefined,
  };
}
