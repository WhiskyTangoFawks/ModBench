import * as vscode from 'vscode';
import { z } from 'zod';
import { AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import type { InstanceValue } from '../instanceLoader/instance';
import { filesNamed, linesNamed, modsNamed, pluginsNamed } from './names';
import { Refusal } from '../drivingLib/refusal';
import { parseOrRefuse } from './refusal';

interface GestureInput {
  /** The Argument the agent gives, as the tool's description teaches it. */
  readonly takes: string;
  readonly callOf: (value: InstanceValue, given: unknown) => AgentCall;
}

function gestureInput<Given>(takes: string, input: z.ZodType<Given>, callOf: (value: InstanceValue, given: Given) => AgentCall): GestureInput {
  return { takes, callOf: (value, given) => callOf(value, parseOrRefuse(input, given)) };
}

const MOD_NAME = z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() });

const modArguments = (value: InstanceValue, argument: readonly z.infer<typeof MOD_NAME>[]) => modsNamed(value.mods, argument).map((entry) => {
  if (entry.kind !== 'mod') throw new Refusal(`"${entry.name}" is a separator, not a mod.`);
  return { kind: 'mod' as const, name: entry.name };
});

const entryArguments = (value: InstanceValue, argument: readonly z.infer<typeof MOD_NAME>[]) =>
  modsNamed(value.mods, argument).map(({ kind, name }) => ({ kind, name }));

const SEPARATOR_NAME = z.object({ name: z.string() });

const separatorArguments = (value: InstanceValue, argument: readonly z.infer<typeof SEPARATOR_NAME>[]) =>
  entryArguments(value, argument.map(({ name }) => ({ name, kind: 'separator' as const })));

const MODS_TAKES = 'argument: the mods, each { name, kind? } as list_mods names it';

const MODS = gestureInput(
  MODS_TAKES,
  z.object({ argument: z.array(MOD_NAME) }),
  (value, { argument }) => new AgentCall(modArguments(value, argument), {}),
);

const MOVE_PLACE = z.union([
  z.object({ kind: z.enum(['ungrouped', 'modOrder']) }),
  z.object({ kind: z.enum(['separator', 'mod']), name: z.string() }),
]);

const placeNamed = (value: InstanceValue, place: z.infer<typeof MOVE_PLACE>) =>
  ('name' in place ? { kind: place.kind, name: modsNamed(value.mods, [{ name: place.name, kind: place.kind }])[0]?.name ?? place.name } : place);

const MOVE_MODS = gestureInput(
  `argument: the mods, or the separators, each { name, kind? } as list_mods names it; options: { place: { kind: 'ungrouped' | 'modOrder' } or { kind: 'separator' | 'mod', name: the one it lands in or beside }, end: 'winning' | 'losing' }`,
  z.object({ argument: z.array(MOD_NAME), options: z.object({ place: MOVE_PLACE, end: z.enum(['winning', 'losing']) }) }),
  (value, { argument, options: { place, end } }) =>
    new AgentCall(entryArguments(value, argument), { place: placeNamed(value, place), end }),
);

const NAME_OPTION = z.object({ options: z.object({ name: z.string() }) });

const RENAME_MOD = gestureInput(
  'argument: the mod, { name } as list_mods names it; options: { name: its new name }',
  NAME_OPTION.extend({ argument: z.array(MOD_NAME) }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), options),
);

const ADD_SEPARATOR = gestureInput(
  'argument: the mod or separator it lands beside, { name, kind? } as list_mods names it; options: { name: the new separator\'s name }',
  NAME_OPTION.extend({ argument: z.array(MOD_NAME) }),
  (value, { argument, options }) => new AgentCall(entryArguments(value, argument), options),
);

const RENAME_SEPARATOR = gestureInput(
  'argument: the separator, { name } as list_mods names it; options: { name: its new name }',
  NAME_OPTION.extend({ argument: z.array(SEPARATOR_NAME) }),
  (value, { argument, options }) => new AgentCall(separatorArguments(value, argument), options),
);

const DELETE_SEPARATORS = gestureInput(
  'argument: the separators, each { name } as list_mods names it',
  z.object({ argument: z.array(SEPARATOR_NAME) }),
  (value, { argument }) => new AgentCall(separatorArguments(value, argument), {}),
);

const CREATE_EMPTY_MOD = gestureInput(
  'options: { name: the new mod\'s name }',
  NAME_OPTION,
  (_value, { options }) => new AgentCall([], options),
);

const FILES = gestureInput(
  'argument: the files, each { mod: { name, kind? } as list_mods names it, path: its path in the mod }',
  z.object({ argument: z.array(z.object({ mod: MOD_NAME, path: z.string() })) }),
  (value, { argument }) => new AgentCall(filesNamed(value, argument).map(({ mod, file }) =>
    ({ kind: 'file', origin: { kind: 'mod', name: mod }, relativePath: file })), {}),
);

const PLUGIN_NAME = z.object({ name: z.string(), origin: z.string().optional() });
const PLUGIN_TAKES = 'each { name, origin? } as list_plugins shows it';

const pluginArguments = (named: typeof pluginsNamed) =>
  (value: InstanceValue, argument: readonly z.infer<typeof PLUGIN_NAME>[]) =>
    named(value.plugins, argument).map((plugin) => ({ kind: 'plugin' as const, plugin }));

const pluginsCall = pluginArguments(pluginsNamed);
const linesCall = pluginArguments(linesNamed);

const LINES = gestureInput(
  `argument: the plugins whose lines in plugins.txt it changes, ${PLUGIN_TAKES}`,
  z.object({ argument: z.array(PLUGIN_NAME) }),
  (value, { argument }) => new AgentCall(linesCall(value, argument), {}),
);

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
  (value, { argument, options }) => new AgentCall(linesCall(value, argument), options),
);

const CREATE_PLUGIN = gestureInput(
  'options: { name: the new plugin\'s file name, place: the origin that will hold it, an enabled mod\'s name or overwrite/ }',
  z.object({ options: z.object({ name: z.string(), place: z.string() }) }),
  (_value, { options }) => new AgentCall([], options),
);

const RENAME_PLUGIN = gestureInput(
  'argument: the plugin, { name, origin? } as list_plugins shows it; options: { name: its new file name }',
  z.object({ argument: PLUGIN_NAME, options: z.object({ name: z.string() }) }),
  (value, { argument, options }) => new AgentCall(linesCall(value, [argument]), options),
);

/** agent.md, Gestures, story 1: the catalog's `writes` gestures, less those it keeps from the agent, plus those it gives.
 *  @public Read by agentGestures.test, which holds it to commands.md. */
export const AGENT_GESTURES: ReadonlyMap<string, GestureInput> = new Map([
  ['modbench.mod.enable', MODS],
  ['modbench.mod.disable', MODS],
  ['modbench.mod.move', MOVE_MODS],
  ['modbench.mod.uninstall', MODS],
  ['modbench.mod.rename', RENAME_MOD],
  ['modbench.mod.createEmpty', CREATE_EMPTY_MOD],
  ['modbench.mod.excludeFile', FILES],
  ['modbench.mod.includeFile', FILES],
  ['modbench.separator.add', ADD_SEPARATOR],
  ['modbench.separator.rename', RENAME_SEPARATOR],
  ['modbench.separator.delete', DELETE_SEPARATORS],
  ['modbench.plugin.enable', LINES],
  ['modbench.plugin.disable', LINES],
  ['modbench.plugin.decompile', PLUGINS],
  ['modbench.plugin.move', MOVE_PLUGINS],
  ['modbench.plugin.create', CREATE_PLUGIN],
  ['modbench.plugin.rename', RENAME_PLUGIN],
]);

type GestureOutcome = GestureResult<unknown>;

function refusalIn(outcome: GestureOutcome): string | undefined {
  if (!outcome.applied) return outcome.detail === undefined ? outcome.refusal : `${outcome.refusal} ${outcome.detail}`;
  const { refused, landed } = outcome.outcome;
  const refusals = refused.length === 0 ? [] : [
    `Refused ${refused.length} of ${refused.length + landed.length}: ${refused.map(({ item, reason }) => `${JSON.stringify(item)} (${reason})`).join(', ')}.`,
  ];
  const partials = (outcome.partial ?? []).map(({ message, detail }) => `${message} ${detail}`);
  return [...refusals, ...partials].join(' ') || undefined;
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
