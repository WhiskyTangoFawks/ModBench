import * as vscode from 'vscode';
import { z } from 'zod';
import { AgentCall } from '../drivingLib/agentGesture';
import type { InstanceValue } from '../instanceLoader/instance';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { modsNamed } from './names';
import { Refusal } from './refusal';

interface AgentGesture {
  /** The Argument and Options the agent gives, as the tool's description teaches them. */
  readonly takes: string;
  readonly callOf: (value: InstanceValue, given: unknown) => AgentCall;
}

function agentGesture<Given>(takes: string, input: z.ZodType<Given>, callOf: (value: InstanceValue, given: Given) => AgentCall): AgentGesture {
  return {
    takes,
    callOf: (value, given) => {
      const parsed = input.safeParse(given);
      if (!parsed.success) throw new Refusal(z.prettifyError(parsed.error));
      return callOf(value, parsed.data);
    },
  };
}

const MOD_NAME = z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() });

const MODS = agentGesture(
  'argument: the mods, each { name, kind? } as list_mods names it',
  z.object({ argument: z.array(MOD_NAME) }),
  (value, { argument }) => new AgentCall(modsNamed(value.mods, argument).map((entry) => {
    if (entry.kind !== 'mod') throw new Refusal(`"${entry.name}" is a separator, not a mod.`);
    return { kind: 'mod', name: entry.name };
  })),
);

/** agent.md, Gestures, story 1: the catalog's `writes` gestures, less those it keeps from the agent, plus those it gives.
 *  @public Read by agentGestures.test, which holds it to commands.md. */
export const AGENT_GESTURES: ReadonlyMap<string, AgentGesture> = new Map([
  ['modbench.mod.enable', MODS],
  ['modbench.mod.disable', MODS],
]);

type GestureOutcome =
  | { applied: true; outcome?: SelectionOutcome<unknown> }
  | { applied: false; refusal: string };

function refusalIn(outcome: GestureOutcome): string | undefined {
  if (!outcome.applied) return outcome.refusal;
  const refused = outcome.outcome?.refused ?? [];
  if (refused.length === 0) return undefined;
  const total = refused.length + (outcome.outcome?.landed.length ?? 0);
  return `Refused ${refused.length} of ${total}: ${refused.map(({ item, reason }) => `${JSON.stringify(item)} (${reason})`).join(', ')}.`;
}

export const RUN_GESTURE = {
  name: 'run_gesture',
  description: 'Run a gesture as the user does, by its Command ID, on the Argument given: never on the selection, and with no picker, prompt or confirmation. '
    + 'It answers once the read model shows the change, with the gesture\'s outcome. A refusal answers the outcome too: what landed, and each item refused and why. Gestures: '
    + [...AGENT_GESTURES].map(([command, { takes }]) => `${command} (${takes})`).join('; '),
  input: { command: z.string(), argument: z.unknown().optional() },
  of: async (value: InstanceValue, { command, ...given }: { command: string; argument?: unknown }) => {
    const gesture = AGENT_GESTURES.get(command);
    if (gesture === undefined) throw new Refusal(`${command} is not a gesture your agent runs.`);
    const outcome = await vscode.commands.executeCommand<GestureOutcome>(command, gesture.callOf(value, given));
    const refusal = refusalIn(outcome);
    if (refusal !== undefined) throw new Refusal(refusal, outcome);
    return outcome;
  },
};
