import * as vscode from 'vscode';
import type { Argument, ArgumentOf } from '../wire/argument';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { Refusal } from './refusal';
import type { Reporter } from '../ports/reporter';
import { gestureEntry, type GestureEntry, type KindedRow } from './gestureEntry';

/** The Argument and the Options an agent call gives a gesture (commands.md, The entry point supplies what it knows). */
export class AgentCall<Options extends object = object> {
  constructor(readonly argument: readonly Argument[], readonly options: Options) {}
}

/** A part of a landed gesture that failed: a view warns of it, or logs it when its severity is `log`, and an agent
 *  is answered it with the Output line the server writes. */
export interface PartialFailure {
  readonly message: string;
  readonly detail: string;
  readonly severity: 'warning' | 'log';
}

/** What a gesture over a selection answers: the outcome, or a refusal that a view reports with its `detail`
 *  and an agent reads with the detail joined on. */
export type GestureResult<T, Refused = T> =
  | { applied: true; outcome: { landed: SelectionOutcome<T>['landed']; refused: SelectionOutcome<Refused>['refused'] }; partial?: readonly PartialFailure[] }
  | { applied: false; refusal: string; detail?: string };

export function reportPartial(reporter: Reporter, partial: readonly PartialFailure[] = [], log: (line: string) => void = () => undefined): void {
  for (const { message, detail, severity } of partial) {
    if (severity === 'warning') reporter.report('warning', message, detail);
    else log(`${message}: ${detail}`);
  }
}

const isKind = <K extends Argument['kind']>(argument: Argument, kinds: readonly K[]): argument is ArgumentOf<K> =>
  (kinds as readonly string[]).includes(argument.kind);

/** The agent box hands a gesture arguments of its kind, or of one of its kinds. */
export function argumentOfKind<K extends Argument['kind']>(argument: Argument, ...kinds: readonly [K, ...K[]]): ArgumentOf<K> {
  if (!isKind(argument, kinds)) {
    throw new Refusal(`An agent call to a ${kinds.join(' or ')} gesture carries ${kinds.join(' or ')}s only, and this one carries a ${argument.kind}.`);
  }
  return argument;
}

/** A gesture the agent runs, by the parts a view call and an agent call share and the parts only a view call has. */
export interface AgentGesture<Row, Given, Outcome, Options extends object = object> {
  /** What a view call acts on: its entry, and what a picker, a prompt or a confirmation adds. Nothing ends it with no write. */
  readonly fromView: (entry: GestureEntry<Row>, option: unknown, clicked: unknown) => Given | undefined | Promise<Given | undefined>;
  readonly fromAgent: (call: AgentCall<Options>) => Given | Promise<Given>;
  readonly run: (given: Given) => Promise<Outcome>;
  /** How a view call surfaces the outcome. An agent call gets the outcome instead (agent.md, Reporting). */
  readonly report: (outcome: Outcome, given: Given) => void;
}

export function registerAgentGesture<Row extends KindedRow, Given, Outcome, Options extends object = object>(
  commandId: string, viewSelection: () => readonly Row[], gesture: AgentGesture<Row, Given, Outcome, Options>,
): vscode.Disposable;
/** A gesture whose rows are not all tree rows says which values are rows. */
export function registerAgentGesture<Row, Given, Outcome, Options extends object = object>(
  commandId: string, viewSelection: () => readonly Row[], gesture: AgentGesture<Row, Given, Outcome, Options>,
  isRow: (value: unknown) => value is Row,
): vscode.Disposable;
export function registerAgentGesture<Row, Given, Outcome, Options extends object = object>(
  commandId: string, viewSelection: () => readonly Row[], gesture: AgentGesture<Row, Given, Outcome, Options>,
  isRow: (value: unknown) => value is Row = (value): value is Row => value instanceof vscode.TreeItem,
): vscode.Disposable {
  const isCall = (value: unknown): value is AgentCall<Options> => value instanceof AgentCall;
  return vscode.commands.registerCommand(commandId, async (clicked?: unknown, selected?: readonly Row[], option?: unknown) => {
    if (isCall(clicked)) return gesture.run(await gesture.fromAgent(clicked));
    const given = await gesture.fromView(gestureEntry(clicked, selected, viewSelection, isRow), option, clicked);
    if (given !== undefined) gesture.report(await gesture.run(given), given);
    return undefined;
  });
}
