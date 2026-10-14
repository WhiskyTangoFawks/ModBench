import * as vscode from 'vscode';
import { z } from 'zod';
import { AgentCall } from '../drivingLib/agentGesture';
import type { InstanceValue } from '../instanceLoader/instance';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import { modsNamed, pluginsNamed } from './names';
import { parseOrRefuse, Refusal } from './refusal';

interface GestureInput {
  /** The Argument the agent gives, as the tool's description teaches it. */
  readonly takes: string;
  readonly callOf: (value: InstanceValue, given: unknown) => AgentCall;
}

function gestureInput<Given>(takes: string, input: z.ZodType<Given>, callOf: (value: InstanceValue, given: Given) => AgentCall): GestureInput {
  return { takes, callOf: (value, given) => callOf(value, parseOrRefuse(input, given)) };
}

const MOD_NAME = z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() });

const MODS = gestureInput(
  'argument: the mods, each { name, kind? } as list_mods names it',
  z.object({ argument: z.array(MOD_NAME) }),
  (value, { argument }) => new AgentCall(modsNamed(value.mods, argument).map((entry) => {
    if (entry.kind !== 'mod') throw new Refusal(`"${entry.name}" is a separator, not a mod.`);
    return { kind: 'mod', name: entry.name };
  }), {}),
);

const PLUGIN_NAME = z.object({ name: z.string(), origin: z.string().optional() });
const PLUGIN_TAKES = 'each { name, origin? } as list_plugins shows it';

const pluginsCall = (value: InstanceValue, argument: readonly z.infer<typeof PLUGIN_NAME>[]) =>
  pluginsNamed(value.plugins, argument).map((plugin) => ({ kind: 'plugin' as const, plugin }));

const PLUGINS = gestureInput(
  `argument: the plugins, ${PLUGIN_TAKES}`,
  z.object({ argument: z.array(PLUGIN_NAME) }),
  (value, { argument }) => new AgentCall(pluginsCall(value, argument), {}),
);

const DROP = z.union([
  z.object({ kind: z.enum(['winningEnd', 'losingEnd']) }),
  z.object({ kind: z.enum(['before', 'after']), name: z.string() }),
]);

const MOVE_PLUGINS = gestureInput(
  `argument: the plugins, ${PLUGIN_TAKES}; options: { drop: { kind: 'winningEnd' | 'losingEnd' } or { kind: 'before' | 'after', name: the plugin file name it lands beside } }`,
  z.object({ argument: z.array(PLUGIN_NAME), options: z.object({ drop: DROP }) }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, argument), options),
);

const CREATE_PLUGIN = gestureInput(
  'options: { name: the new plugin\'s file name, place: the origin that will hold it, an enabled mod\'s name or overwrite/ }',
  z.object({ options: z.object({ name: z.string(), place: z.string() }) }),
  (_value, { options }) => new AgentCall([], options),
);

const RENAME_PLUGIN = gestureInput(
  'argument: the plugin, { name, origin? } as list_plugins shows it; options: { name: its new file name }',
  z.object({ argument: PLUGIN_NAME, options: z.object({ name: z.string() }) }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, [argument]), options),
);

/** agent.md, Gestures, story 1: the catalog's `writes` gestures, less those it keeps from the agent, plus those it gives.
 *  @public Read by agentGestures.test, which holds it to commands.md. */
export const AGENT_GESTURES: ReadonlyMap<string, GestureInput> = new Map([
  ['modbench.mod.enable', MODS],
  ['modbench.mod.disable', MODS],
  ['modbench.plugin.enable', PLUGINS],
  ['modbench.plugin.disable', PLUGINS],
  ['modbench.plugin.decompile', PLUGINS],
  ['modbench.plugin.move', MOVE_PLUGINS],
  ['modbench.plugin.create', CREATE_PLUGIN],
  ['modbench.plugin.rename', RENAME_PLUGIN],
]);

type GestureOutcome =
  | { applied: true; outcome: SelectionOutcome<unknown> }
  | { applied: false; refusal: string };

function refusalIn(outcome: GestureOutcome): string | undefined {
  if (!outcome.applied) return outcome.refusal;
  const { refused, landed } = outcome.outcome;
  if (refused.length === 0) return undefined;
  const total = refused.length + landed.length;
  return `Refused ${refused.length} of ${total}: ${refused.map(({ item, reason }) => `${JSON.stringify(item)} (${reason})`).join(', ')}.`;
}

export const RUN_GESTURE = {
  name: 'run_gesture',
  description: 'Run a gesture as the user does, by its Command ID, on the Argument and Options given: never on the selection, and with no picker, prompt or confirmation. '
    + 'It answers once the read model shows the change, with the gesture\'s outcome. A refusal answers the outcome too: what landed, and each item refused and why. Gestures: '
    + [...AGENT_GESTURES].map(([command, { takes }]) => `${command} (${takes})`).join('; '),
  input: { command: z.string(), argument: z.unknown().optional(), options: z.unknown().optional() },
  of: async (value: InstanceValue, { command, ...given }: { command: string; argument?: unknown; options?: unknown }) => {
    const gesture = AGENT_GESTURES.get(command);
    if (gesture === undefined) throw new Refusal(`${command} is not a gesture your agent runs.`);
    const outcome = await vscode.commands.executeCommand<GestureOutcome>(command, gesture.callOf(value, given));
    const refusal = refusalIn(outcome);
    if (refusal !== undefined) throw new Refusal(refusal, outcome);
    return outcome;
  },
};
