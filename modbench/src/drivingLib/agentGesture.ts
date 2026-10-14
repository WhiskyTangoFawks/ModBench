import * as vscode from 'vscode';
import type { Argument } from '../wire/argument';
import { gestureEntry, type GestureEntry, type KindedRow } from './gestureEntry';

/** The Argument and the Options an agent call gives a gesture (commands.md, The surface supplies the Argument). */
export class AgentCall<Options extends object = object> {
  constructor(readonly argument: readonly Argument[], readonly options: Options) {}
}

/** A gesture the agent runs, by the parts a view call and an agent call share and the parts only a view call has. */
export interface AgentGesture<Row extends KindedRow, Given, Outcome, Options extends object = object> {
  /** What a view call acts on: its entry, and what a picker, a prompt or a confirmation adds. Nothing ends it with no write. */
  readonly fromView: (entry: GestureEntry<Row>, option: unknown, clicked: unknown) => Given | undefined | Promise<Given | undefined>;
  readonly fromAgent: (call: AgentCall<Options>) => Given | Promise<Given>;
  readonly run: (given: Given) => Promise<Outcome>;
  /** How a view call surfaces the outcome. An agent call gets the outcome instead (agent.md, Reporting). */
  readonly report: (outcome: Outcome, given: Given) => void;
}

export function registerAgentGesture<Row extends KindedRow, Given, Outcome, Options extends object = object>(
  commandId: string, viewSelection: () => readonly Row[], gesture: AgentGesture<Row, Given, Outcome, Options>,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (clicked?: unknown, selected?: readonly Row[], option?: unknown) => {
    if (clicked instanceof AgentCall) return gesture.run(await gesture.fromAgent(clicked));
    const given = await gesture.fromView(gestureEntry(clicked, selected, viewSelection), option, clicked);
    if (given !== undefined) gesture.report(await gesture.run(given), given);
    return undefined;
  });
}
