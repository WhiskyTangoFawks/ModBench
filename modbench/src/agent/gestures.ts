import * as vscode from 'vscode';
import { z } from 'zod';
import { AgentCall, type GestureResult } from '../drivingLib/agentGesture';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Argument } from '../wire/argument';
import { CONTAINER_NAME, downloadedFilesNamed, filesAndFoldersNamed, filesNamed, linesNamed, modsNamed, namedByOwnPath, pluginsNamed } from './names';
import type { MEditClient } from '../client/MEditClient';
import { deployFailures, deployWarnings } from '../drivingLib/deployProblems';
import type { Deployed } from '../deployment/deployment';
import { Refusal } from '../drivingLib/refusal';
import { formKeysNamed } from './recordNames';
import { parseOrRefuse } from './refusal';

interface GestureInput {
  readonly input: z.ZodRawShape;
  readonly callOf: (value: InstanceValue, given: unknown, mEdit: NameResolver) => AgentCall | Promise<AgentCall>;
}

type NameResolver = Pick<MEditClient, 'resolveNames'>;

function gestureInput<Shape extends z.ZodRawShape>(
  input: z.ZodObject<Shape>,
  callOf: (value: InstanceValue, given: z.output<z.ZodObject<Shape>>, mEdit: NameResolver) => AgentCall | Promise<AgentCall>,
): GestureInput {
  return { input: input.shape, callOf: (value, given, mEdit) => callOf(value, parseOrRefuse(input, given), mEdit) };
}

const ENTRY_NAME = z.strictObject({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() });

const entryArguments = (value: InstanceValue, argument: readonly z.infer<typeof ENTRY_NAME>[]) =>
  modsNamed(value, argument).map(({ kind, name }) => ({ kind, name }));

const modArguments = (value: InstanceValue, argument: readonly z.infer<typeof ENTRY_NAME>[]) =>
  entryArguments(value, argument).map((entry) => {
    if (entry.kind !== 'mod') throw new Refusal(`"${entry.name}" is a separator, not a mod.`);
    return { kind: 'mod' as const, name: entry.name };
  });

const SEPARATOR_NAME = z.strictObject({ name: z.string() });

const separatorArguments = (value: InstanceValue, argument: readonly z.infer<typeof SEPARATOR_NAME>[]) =>
  entryArguments(value, argument.map(({ name }) => ({ name, kind: 'separator' as const })));

const MODS = gestureInput(
  z.strictObject({ argument: z.array(ENTRY_NAME) }),
  (value, { argument }) => new AgentCall(modArguments(value, argument), {}),
);

const VERSION_IN_GIT = gestureInput(
  z.strictObject({ argument: z.array(ENTRY_NAME), options: z.strictObject({ where: z.enum(['NewRepository', 'InstanceRepository', 'WholeFolder']), commit: z.boolean() }) }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), options),
);

const MOVE_PLACE = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['ungrouped', 'modOrder']) }),
  z.strictObject({ kind: z.enum(['separator', 'mod']), name: z.string() }),
]);

const placeNamed = (value: InstanceValue, place: z.infer<typeof MOVE_PLACE>) =>
  ('name' in place ? { kind: place.kind, name: modsNamed(value, [{ name: place.name, kind: place.kind }])[0]?.name ?? place.name } : place);

const MOVE_MODS = gestureInput(
  z.strictObject({ argument: z.array(ENTRY_NAME), options: z.strictObject({ place: MOVE_PLACE, end: z.enum(['winning', 'losing']) }) }),
  (value, { argument, options: { place, end } }) =>
    new AgentCall(entryArguments(value, argument), { place: placeNamed(value, place), end }),
);

const NAME_OPTION = z.strictObject({ options: z.strictObject({ name: z.string() }) });

const RENAME_MOD = gestureInput(
  NAME_OPTION.extend({ argument: z.array(ENTRY_NAME) }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), options),
);

const ADD_SEPARATOR = gestureInput(
  NAME_OPTION.extend({ argument: z.array(ENTRY_NAME) }),
  (value, { argument, options }) => new AgentCall(entryArguments(value, argument), options),
);

const UNINSTALL = gestureInput(
  z.strictObject({ argument: z.array(ENTRY_NAME), options: z.strictObject({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), { force: options?.force }),
);

const RENAME_SEPARATOR = gestureInput(
  NAME_OPTION.extend({ argument: z.array(SEPARATOR_NAME) }),
  (value, { argument, options }) => new AgentCall(separatorArguments(value, argument), options),
);

const DELETE_SEPARATORS = gestureInput(
  z.strictObject({ argument: z.array(SEPARATOR_NAME), options: z.strictObject({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(separatorArguments(value, argument), { force: options?.force }),
);

const CREATE_EMPTY_MOD = gestureInput(
  NAME_OPTION,
  (_value, { options }) => new AgentCall([], options),
);

const FILES = gestureInput(
  z.strictObject({ argument: z.array(z.strictObject({ mod: CONTAINER_NAME, path: z.string() })) }),
  (value, { argument }) => new AgentCall(filesNamed(value, argument).map(({ origin, relativePath }) =>
    ({ kind: 'file', origin, relativePath })), {}),
);

const PUBLISHER_TAG_ROWS = gestureInput(
  z.strictObject({
    argument: z.array(z.strictObject({ mod: ENTRY_NAME, path: z.string().optional() })),
    options: z.strictObject({ tag: z.string() }),
  }),
  (value, { argument, options }) => {
    const mods = modArguments(value, argument.filter(({ path }) => path === undefined).map(({ mod }) => mod));
    const paths = filesAndFoldersNamed(value, argument.flatMap(({ mod, path }) => (path === undefined ? [] : [{ mod, path }])))
      .map(({ origin, relativePath }): Argument => ({ kind: 'file', origin, relativePath }));
    return new AgentCall([...mods, ...paths], options);
  },
);

const DOWNLOADED_FILES = gestureInput(
  z.strictObject({ argument: z.array(z.strictObject({ name: z.string() })) }),
  (value, { argument }) => new AgentCall(
    downloadedFilesNamed(value.downloadedFiles, argument.map(({ name }) => name)).map((name) => ({ kind: 'downloadedFile' as const, name })), {}),
);

const DOWNLOAD = gestureInput(
  z.strictObject({ options: z.strictObject({ mod: z.union([z.string(), z.number()]), file: z.union([z.string(), z.number()]).optional() }) }),
  (_value, { options: { mod, file } }) => new AgentCall([], { mod: String(mod), file: file === undefined ? undefined : String(file) }),
);

const INSTALL_SOURCE = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('downloadedFile'), name: z.string() }),
  z.strictObject({ kind: z.enum(['archive', 'folder']), path: z.string() }),
]);

const FOMOD_CHOICE = z.strictObject({
  step: z.string(),
  groups: z.array(z.strictObject({ group: z.string(), options: z.array(z.string()) })),
});

const INSTALL = gestureInput(
  z.strictObject({
    argument: z.array(INSTALL_SOURCE),
    options: z.strictObject({
      name: z.string().optional(), target: z.string().optional(),
      choices: z.array(FOMOD_CHOICE).optional(), installer: z.boolean().optional(), manual: z.boolean().optional(), installAnyway: z.boolean().optional(),
    }).default({}),
  }),
  (value, { argument, options: { name, target, choices, installer, manual, installAnyway } }) => new AgentCall(
    argument.map((source) => (source.kind === 'downloadedFile'
      ? { kind: source.kind, name: downloadedFilesNamed(value.downloadedFiles, [source.name])[0] ?? source.name }
      : source)),
    { name, target: target === undefined ? undefined : modsNamed(value, [{ name: target, kind: 'mod' }])[0]?.name, choices, installer, manual, installAnyway },
  ),
);

const NO_INPUT = gestureInput(z.strictObject({}), () => new AgentCall([], {}));

const UPDATE_MASTERLIST = gestureInput(
  z.strictObject({ options: z.strictObject({ force: z.boolean().optional() }).optional() }),
  (_value, { options }) => new AgentCall([], { force: options?.force }),
);

const SWITCH_PROFILE = gestureInput(
  z.strictObject({ argument: z.array(z.strictObject({ name: z.string() })) }),
  (_value, { argument }) => new AgentCall(argument.map(({ name }) => ({ kind: 'profile', name })), {}),
);

const MOVE_TO_OVERWRITE = gestureInput(
  z.strictObject({ argument: z.array(z.strictObject({ path: z.string() })).optional() }),
  (_value, { argument }) => new AgentCall((argument ?? []).map(({ path }) => ({ kind: 'deployedFile', path })), {}),
);

const EVERY_MOD_BY_DEFAULT = z.strictObject({ argument: z.array(ENTRY_NAME).optional() });

const MODS_OR_EVERY_MOD = gestureInput(
  EVERY_MOD_BY_DEFAULT,
  (value, { argument }) => new AgentCall(entryArguments(value, argument ?? []), {}),
);

const SOURCE_FOLDER = z.strictObject({ kind: z.literal('folder'), path: z.string() });

const UPDATE_MANIFEST = gestureInput(
  z.strictObject({ argument: z.array(z.discriminatedUnion('kind', [ENTRY_NAME, SOURCE_FOLDER])).optional() }),
  (value, { argument = [] }) => new AgentCall([
    ...entryArguments(value, argument.filter((one): one is z.infer<typeof ENTRY_NAME> => !('path' in one))),
    ...argument.filter((one): one is z.infer<typeof SOURCE_FOLDER> => 'path' in one),
  ], {}),
);

const BUILD = gestureInput(
  EVERY_MOD_BY_DEFAULT,
  (value, { argument }) => new AgentCall(modArguments(value, argument ?? []), {}),
);

const PLUGIN_NAME = z.strictObject({ name: z.string(), origin: z.string().optional() });

const pluginArguments = (named: typeof pluginsNamed) =>
  (value: InstanceValue, argument: readonly z.infer<typeof PLUGIN_NAME>[]) =>
    named(value, argument).map((plugin) => ({ kind: 'plugin' as const, plugin }));

const pluginsCall = pluginArguments(pluginsNamed);
const linesCall = pluginArguments(linesNamed);

const LINES = gestureInput(
  z.strictObject({ argument: z.array(PLUGIN_NAME) }),
  (value, { argument }) => new AgentCall(linesCall(value, argument), {}),
);

const DECOMPILE = gestureInput(
  z.strictObject({ argument: z.array(PLUGIN_NAME), options: z.strictObject({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, argument), { force: options?.force }),
);

const DECOMPILE_AND_REPAIR = gestureInput(
  z.strictObject({ argument: z.array(PLUGIN_NAME), options: z.strictObject({ where: z.enum(['NewRepository', 'InstanceRepository']).optional(), force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, argument), { where: options?.where, force: options?.force }),
);

const DROP = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['winningEnd', 'losingEnd']) }),
  z.strictObject({ kind: z.enum(['before', 'after']), name: z.string() }),
]);

const MOVE_PLUGINS = gestureInput(
  z.strictObject({ argument: z.array(PLUGIN_NAME), options: z.strictObject({ drop: DROP }) }),
  (value, { argument, options }) => new AgentCall(linesCall(value, argument), options),
);

const APPLY_SUGGESTED_MOVE = gestureInput(
  z.strictObject({ argument: PLUGIN_NAME, options: z.strictObject({ rule: z.string().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(linesCall(value, [argument]), { rule: options?.rule }),
);

const LOAD_AFTER = gestureInput(
  z.strictObject({ argument: z.array(PLUGIN_NAME), options: z.strictObject({ after: z.array(z.strictObject({ name: z.string() })) }) }),
  (value, { argument, options }) => new AgentCall(linesCall(value, argument), options),
);

const CREATE_PLUGIN = gestureInput(
  z.strictObject({ argument: z.array(CONTAINER_NAME), options: z.strictObject({ name: z.string(), flags: z.array(z.string()).optional() }) }),
  (value, { argument, options }) => new AgentCall(
    argument.flatMap((container): Argument[] => (container.kind === 'runtimeOutput'
      ? [{ kind: 'runtimeOutput' }]
      : modArguments(value, [{ name: container.name, kind: container.kind }]))),
    options,
  ),
);

const RENAME_PLUGIN = gestureInput(
  z.strictObject({ argument: PLUGIN_NAME, options: z.strictObject({ name: z.string() }) }),
  (value, { argument, options }) => new AgentCall(linesCall(value, [argument]), options),
);

const OPEN_RECORD = gestureInput(
  z.strictObject({
    argument: z.array(z.strictObject({ name: z.string(), plugin: PLUGIN_NAME.optional() })),
    options: z.strictObject({ pinned: z.boolean().optional() }).optional(),
  }),
  async (value, { argument, options }, mEdit) => {
    const formKeys = await formKeysNamed(mEdit, argument.map(({ name }) => name));
    return new AgentCall(
      formKeys.map((formKey, at) => ({
        kind: 'record' as const, formKey, ...(argument[at]?.plugin && { plugin: pluginsNamed(value, [argument[at].plugin])[0] }),
      })),
      { pinned: options?.pinned },
    );
  },
);

/** agent.md, Gestures, story 1: the catalog's `writes` gestures, less those it keeps from the agent, plus those it gives.
 *  @public Read by agentGestures.test, which holds it to commands.md. */
export const AGENT_GESTURES: ReadonlyMap<string, GestureInput> = new Map([
  ['modbench.mod.enable', MODS],
  ['modbench.mod.disable', MODS],
  ['modbench.mod.move', MOVE_MODS],
  ['modbench.mod.uninstall', UNINSTALL],
  ['modbench.mod.versionInGit', VERSION_IN_GIT],
  ['modbench.mod.build', BUILD],
  ['modbench.mod.rename', RENAME_MOD],
  ['modbench.mod.createEmpty', CREATE_EMPTY_MOD],
  ['modbench.mod.excludeFile', FILES],
  ['modbench.mod.includeFile', FILES],
  ['modbench.mod.ignoreFile', FILES],
  ['modbench.mod.unignoreFile', FILES],
  ['modbench.mod.addPublisherTag', PUBLISHER_TAG_ROWS],
  ['modbench.mod.removePublisherTag', PUBLISHER_TAG_ROWS],
  ['modbench.mod.install', INSTALL],
  ['modbench.downloadedFile.queryInfo', DOWNLOADED_FILES],
  ['modbench.downloadedFile.download', DOWNLOAD],
  ['modbench.downloadedFile.exclude', DOWNLOADED_FILES],
  ['modbench.downloadedFile.include', DOWNLOADED_FILES],
  ['modbench.downloadedFile.delete', DOWNLOADED_FILES],
  ['modbench.separator.add', ADD_SEPARATOR],
  ['modbench.separator.rename', RENAME_SEPARATOR],
  ['modbench.separator.delete', DELETE_SEPARATORS],
  ['modbench.plugin.enable', LINES],
  ['modbench.plugin.disable', LINES],
  ['modbench.plugin.decompile', DECOMPILE],
  ['modbench.plugin.decompileAndRepair', DECOMPILE_AND_REPAIR],
  ['modbench.plugin.move', MOVE_PLUGINS],
  ['modbench.plugin.applySuggestedMove', APPLY_SUGGESTED_MOVE],
  ['modbench.plugin.loadAfter', LOAD_AFTER],
  ['modbench.plugin.create', CREATE_PLUGIN],
  ['modbench.plugin.rename', RENAME_PLUGIN],
  ['modbench.record.open', OPEN_RECORD],
  ['modbench.modlist.gitInit', NO_INPUT],
  ['modbench.profile.switch', SWITCH_PROFILE],
  ['modbench.instance.refresh', NO_INPUT],
  ['modbench.instance.deploy', NO_INPUT],
  ['modbench.instance.purge', NO_INPUT],
  ['modbench.instance.moveToOverwrite', MOVE_TO_OVERWRITE],
  ['modbench.instance.updateMasterlist', UPDATE_MASTERLIST],
  ['modbench.instance.logOut', NO_INPUT],
  ['modbench.mod.updateManifest', UPDATE_MANIFEST],
  ['modbench.mod.checkForUpdates', MODS_OR_EVERY_MOD],
  ['modbench.mod.restoreFromManifest', MODS_OR_EVERY_MOD],
]);

type GestureOutcome = GestureResult<unknown>;

type DeployOutcome = ({ applied: true } & Deployed) | { applied: false; refusal: string };

const isDeployed = (answer: GestureOutcome | DeployOutcome): answer is { applied: true } & Deployed => answer.applied && 'pluginsTxt' in answer;

function deployAnswered(answer: { applied: true } & Deployed): GestureOutcome {
  const partial = [...deployFailures(answer), ...deployWarnings(answer)].map((problem) => ({ ...problem, severity: 'warning' as const }));
  return { applied: true, outcome: { landed: [], refused: [] }, ...(partial.length === 0 ? {} : { partial }) };
}

const partialsIn = ({ partial = [] }: Extract<GestureOutcome, { applied: true }>): string[] =>
  partial.map(({ message, detail }) => `${message} ${detail}`);

function refusalIn(outcome: GestureOutcome): string | undefined {
  if (!outcome.applied) return outcome.detail === undefined ? outcome.refusal : `${outcome.refusal} ${outcome.detail}`;
  const { refused, landed } = outcome.outcome;
  if (refused.length === 0) return undefined;
  return [
    `Refused ${refused.length} of ${refused.length + landed.length}: ${refused.map(({ item, reason }) => `${JSON.stringify(item)} (${reason})`).join(', ')}.`,
    ...partialsIn(outcome),
  ].join(' ');
}

function answerOf(outcome: GestureOutcome) {
  return outcome.applied
    ? { landed: outcome.outcome.landed, refused: outcome.outcome.refused, partial: outcome.partial }
    : { refusal: outcome.refusal, detail: outcome.detail };
}

function namedOwn(value: InstanceValue, outcome: GestureOutcome): GestureOutcome {
  if (!outcome.applied) return outcome;
  const { landed, refused } = outcome.outcome;
  return {
    ...outcome,
    outcome: { landed: landed.map((item) => namedByOwnPath(value, item)), refused: refused.map((one) => ({ ...one, item: namedByOwnPath(value, one.item) })) },
  };
}

const toolName = (command: string): string =>
  command.replace(/^modbench\./, '').replaceAll('.', '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Claude Code sends an input with no JSON type as a string. */
export const GESTURE_TOOLS = [...AGENT_GESTURES].map(([command, gesture]) => ({
  name: toolName(command),
  input: gesture.input,
  of: async (value: InstanceValue, mEdit: NameResolver, given: unknown, warn: (line: string) => void) => {
    const answer = await vscode.commands.executeCommand<GestureOutcome | DeployOutcome>(command, await gesture.callOf(value, given, mEdit));
    const outcome = namedOwn(value, isDeployed(answer) ? deployAnswered(answer) : answer);
    const refusal = refusalIn(outcome);
    if (refusal !== undefined) throw new Refusal(refusal, answerOf(outcome));
    if (outcome.applied) partialsIn(outcome).forEach(warn);
    return answerOf(outcome);
  },
}));
