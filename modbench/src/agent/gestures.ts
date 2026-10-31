import * as vscode from 'vscode';
import { z } from 'zod';
import { AgentCall, type DeployedFileArgument, type GestureResult, type ProfileArgument } from '../drivingLib/agentGesture';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Argument } from '../wire/argument';
import { downloadedFilesNamed, filesAndFoldersNamed, filesNamed, linesNamed, modsNamed, pluginsNamed } from './names';
import type { MEditClient } from '../client/MEditClient';
import { deployFailures, deployWarnings } from '../deployment/deployProblems';
import type { Deployed } from '../deployment/deployment';
import { Refusal } from '../drivingLib/refusal';
import { formKeysNamed } from './recordNames';
import { parseOrRefuse } from './refusal';

interface GestureInput {
  /** The Argument the agent gives, as the tool's description teaches it. */
  readonly takes: string;
  readonly input: z.ZodRawShape;
  readonly callOf: (value: InstanceValue, given: unknown, mEdit: NameResolver) => AnyCall | Promise<AnyCall>;
}

type AnyCall = AgentCall<object, object>;

type NameResolver = Pick<MEditClient, 'resolveNames'>;

function gestureInput<Shape extends z.ZodRawShape>(
  takes: string, input: z.ZodObject<Shape>,
  callOf: (value: InstanceValue, given: z.output<z.ZodObject<Shape>>, mEdit: NameResolver) => AnyCall | Promise<AnyCall>,
): GestureInput {
  return { takes, input: input.shape, callOf: (value, given, mEdit) => callOf(value, parseOrRefuse(input, given), mEdit) };
}

const ENTRY_NAME = z.object({ name: z.string(), kind: z.enum(['mod', 'separator']).optional() });

const entryArguments = (value: InstanceValue, argument: readonly z.infer<typeof ENTRY_NAME>[]) =>
  modsNamed(value, argument).map(({ kind, name }) => ({ kind, name }));

const modArguments = (value: InstanceValue, argument: readonly z.infer<typeof ENTRY_NAME>[]) =>
  entryArguments(value, argument).map((entry) => {
    if (entry.kind !== 'mod') throw new Refusal(`"${entry.name}" is a separator, not a mod.`);
    return { kind: 'mod' as const, name: entry.name };
  });

const SEPARATOR_NAME = z.object({ name: z.string() });

const separatorArguments = (value: InstanceValue, argument: readonly z.infer<typeof SEPARATOR_NAME>[]) =>
  entryArguments(value, argument.map(({ name }) => ({ name, kind: 'separator' as const })));

const MODS_TAKES = 'argument: the mods, each { name, kind? } as list_mods names it';

const MODS = gestureInput(
  MODS_TAKES,
  z.object({ argument: z.array(ENTRY_NAME) }),
  (value, { argument }) => new AgentCall(modArguments(value, argument), {}),
);

const MOVE_PLACE = z.union([
  z.object({ kind: z.enum(['ungrouped', 'modOrder']) }),
  z.object({ kind: z.enum(['separator', 'mod']), name: z.string() }),
]);

const placeNamed = (value: InstanceValue, place: z.infer<typeof MOVE_PLACE>) =>
  ('name' in place ? { kind: place.kind, name: modsNamed(value, [{ name: place.name, kind: place.kind }])[0]?.name ?? place.name } : place);

const MOVE_MODS = gestureInput(
  `argument: the mods, or the separators, each { name, kind? } as list_mods names it; options: { place: { kind: 'ungrouped' | 'modOrder' } or { kind: 'separator' | 'mod', name: the one it lands in or beside }, end: 'winning' | 'losing' }`,
  z.object({ argument: z.array(ENTRY_NAME), options: z.object({ place: MOVE_PLACE, end: z.enum(['winning', 'losing']) }) }),
  (value, { argument, options: { place, end } }) =>
    new AgentCall(entryArguments(value, argument), { place: placeNamed(value, place), end }),
);

const NAME_OPTION = z.object({ options: z.object({ name: z.string() }) });

const RENAME_MOD = gestureInput(
  'argument: the mod, { name } as list_mods names it; options: { name: its new name }',
  NAME_OPTION.extend({ argument: z.array(ENTRY_NAME) }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), options),
);

const ADD_SEPARATOR = gestureInput(
  'argument: the mod or separator it lands beside, { name, kind? } as list_mods names it; options: { name: the new separator\'s name }',
  NAME_OPTION.extend({ argument: z.array(ENTRY_NAME) }),
  (value, { argument, options }) => new AgentCall(entryArguments(value, argument), options),
);

const UNINSTALL = gestureInput(
  `${MODS_TAKES}; options: { force?: true to uninstall, which is otherwise refused for each mod, listing what it loses }`,
  z.object({ argument: z.array(ENTRY_NAME), options: z.object({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(modArguments(value, argument), { force: options?.force }),
);

const RENAME_SEPARATOR = gestureInput(
  'argument: the separator, { name } as list_mods names it; options: { name: its new name }',
  NAME_OPTION.extend({ argument: z.array(SEPARATOR_NAME) }),
  (value, { argument, options }) => new AgentCall(separatorArguments(value, argument), options),
);

const DELETE_SEPARATORS = gestureInput(
  'argument: the separators, each { name } as list_mods names it; options: { force?: true to delete, which is otherwise refused for each separator, naming the separator its mods would join }',
  z.object({ argument: z.array(SEPARATOR_NAME), options: z.object({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(separatorArguments(value, argument), { force: options?.force }),
);

const CREATE_EMPTY_MOD = gestureInput(
  'options: { name: the new mod\'s name }',
  NAME_OPTION,
  (_value, { options }) => new AgentCall([], options),
);

const FILES = gestureInput(
  'argument: the files, each { mod: { name, kind? } as list_mods names it, path: its path in the mod }',
  z.object({ argument: z.array(z.object({ mod: ENTRY_NAME, path: z.string() })) }),
  (value, { argument }) => new AgentCall(filesNamed(value, argument).map(({ mod, file }) =>
    ({ kind: 'file', origin: { kind: 'mod', name: mod }, relativePath: file })), {}),
);

const PUBLISHER_TAG_ROWS = gestureInput(
  'argument: the mods, each { mod: { name, kind? } as list_mods names it }, or the files and folders in a mod, each { mod, path: its path in the mod }; options: { tag: the publisher tag\'s name }',
  z.object({
    argument: z.array(z.object({ mod: ENTRY_NAME, path: z.string().optional() })),
    options: z.object({ tag: z.string() }),
  }),
  (value, { argument, options }) => {
    const mods = modArguments(value, argument.filter(({ path }) => path === undefined).map(({ mod }) => mod));
    const paths = filesAndFoldersNamed(value, argument.flatMap(({ mod, path }) => (path === undefined ? [] : [{ mod, path }])))
      .map(({ mod, file }): Argument => ({ kind: 'file', origin: { kind: 'mod', name: mod }, relativePath: file }));
    return new AgentCall([...mods, ...paths], options);
  },
);

const DOWNLOADED_FILES = gestureInput(
  'argument: the downloaded files, each { name } as list_downloads names it',
  z.object({ argument: z.array(z.object({ name: z.string() })) }),
  (value, { argument }) => new AgentCall(
    downloadedFilesNamed(value.downloadedFiles, argument.map(({ name }) => name)).map((name) => ({ kind: 'downloadedFile' as const, name })), {}),
);

const INSTALL_SOURCE = z.union([
  z.object({ kind: z.literal('downloadedFile'), name: z.string() }),
  z.object({ kind: z.enum(['archive', 'folder']), path: z.string() }),
]);

const FOMOD_CHOICE = z.object({
  step: z.string(),
  groups: z.array(z.object({ group: z.string(), options: z.array(z.string()) })),
});

const INSTALL = gestureInput(
  'argument: the one source, { kind: \'downloadedFile\', name } as list_downloads names it, or { kind: \'archive\' | \'folder\', path } for one outside the downloads; '
    + 'options: { name: the new mod\'s name } or { target: the installed mod it upgrades, as list_mods names it }, exactly one of the two; '
    + 'for a FOMOD, choices?: [{ step, groups: [{ group, options: [option] }] }], each by the name its installer shows, every step it shows answered, a step that needs no pick with none, '
    + 'or manual?: true to install it as a plain copy, which a scripted FOMOD, one whose installer cannot be read and one whose module dependencies do not hold are refused without; a step left unanswered is refused, listing its groups and options, and nothing is picked for you, not even the author\'s defaults; a FOMOD that names files its package does not hold is refused, naming each, unless installAnyway?: true',
  z.object({
    argument: z.array(INSTALL_SOURCE),
    options: z.object({
      name: z.string().optional(), target: z.string().optional(),
      choices: z.array(FOMOD_CHOICE).optional(), manual: z.boolean().optional(), installAnyway: z.boolean().optional(),
    }).default({}),
  }),
  (value, { argument, options: { name, target, choices, manual, installAnyway } }) => new AgentCall(
    argument.map((source) => (source.kind === 'downloadedFile'
      ? { kind: source.kind, name: downloadedFilesNamed(value.downloadedFiles, [source.name])[0] ?? source.name }
      : source)),
    { name, target: target === undefined ? undefined : modsNamed(value, [{ name: target, kind: 'mod' }])[0]?.name, choices, manual, installAnyway },
  ),
);

const NO_INPUT = gestureInput('', z.object({}), () => new AgentCall([], {}));

const SWITCH_PROFILE = gestureInput(
  'argument: the one profile, { name } as list_profiles names it',
  z.object({ argument: z.array(z.object({ name: z.string() })) }),
  (_value, { argument }) => new AgentCall<object, ProfileArgument>(argument.map(({ name }) => ({ kind: 'profile', name })), {}),
);

const MOVE_TO_OVERWRITE = gestureInput(
  'argument?: the files the deployment folder holds that deploy does not manage, each { path } below the deployment folder, or none for every one',
  z.object({ argument: z.array(z.object({ path: z.string() })).optional() }),
  (_value, { argument }) => new AgentCall<object, DeployedFileArgument>((argument ?? []).map(({ path }) => ({ kind: 'deployedFile', path })), {}),
);


const EVERY_MOD_BY_DEFAULT_TAKES = 'argument?: the mods or separators, each { name, kind? } as list_mods names it, or none for every mod';
const EVERY_MOD_BY_DEFAULT = z.object({ argument: z.array(ENTRY_NAME).optional() });

const MODS_OR_EVERY_MOD = gestureInput(
  EVERY_MOD_BY_DEFAULT_TAKES,
  EVERY_MOD_BY_DEFAULT,
  (value, { argument }) => new AgentCall(entryArguments(value, argument ?? []), {}),
);

const BUILD = gestureInput(
  'argument?: the mods, each { name, kind? } as list_mods names it, or none for every source in the source folder',
  EVERY_MOD_BY_DEFAULT,
  (value, { argument }) => new AgentCall(modArguments(value, argument ?? []), {}),
);

const PLUGIN_NAME = z.object({ name: z.string(), origin: z.string().optional() });
const PLUGIN_TAKES = 'each { name, origin? } as list_plugins shows it';

const pluginArguments = (named: typeof pluginsNamed) =>
  (value: InstanceValue, argument: readonly z.infer<typeof PLUGIN_NAME>[]) =>
    named(value, argument).map((plugin) => ({ kind: 'plugin' as const, plugin }));

const pluginsCall = pluginArguments(pluginsNamed);
const linesCall = pluginArguments(linesNamed);

const LINES = gestureInput(
  `argument: the plugins whose lines in plugins.txt it changes, ${PLUGIN_TAKES}`,
  z.object({ argument: z.array(PLUGIN_NAME) }),
  (value, { argument }) => new AgentCall(linesCall(value, argument), {}),
);

const DECOMPILE = gestureInput(
  `argument: the plugins, ${PLUGIN_TAKES}; options: { force?: true to replace a plugin source that has working-tree changes, which is otherwise refused }`,
  z.object({ argument: z.array(PLUGIN_NAME), options: z.object({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, argument), { force: options?.force }),
);

const DECOMPILE_AND_REPAIR = gestureInput(
  `argument: the plugins, ${PLUGIN_TAKES}; options: { force?: true to repair a plugin whose plugin source has working-tree changes, which is otherwise refused, listing what it would lose }`,
  z.object({ argument: z.array(PLUGIN_NAME), options: z.object({ force: z.boolean().optional() }).optional() }),
  (value, { argument, options }) => new AgentCall(pluginsCall(value, argument), { force: options?.force }),
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

const OPEN_RECORD = gestureInput(
  'argument: the records, each { name: its EditorID or FormKey, plugin?: { name, origin? } as list_plugins shows it }, a copy when it names its plugin, else the winning copy; options: { pinned?: true to keep the tab }',
  z.object({
    argument: z.array(z.object({ name: z.string(), plugin: PLUGIN_NAME.optional() })),
    options: z.object({ pinned: z.boolean().optional() }).optional(),
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
  ['modbench.mod.decompileAndCommit', MODS],
  ['modbench.mod.build', BUILD],
  ['modbench.mod.rename', RENAME_MOD],
  ['modbench.mod.createEmpty', CREATE_EMPTY_MOD],
  ['modbench.mod.excludeFile', FILES],
  ['modbench.mod.includeFile', FILES],
  ['modbench.mod.addPublisherTag', PUBLISHER_TAG_ROWS],
  ['modbench.mod.removePublisherTag', PUBLISHER_TAG_ROWS],
  ['modbench.mod.install', INSTALL],
  ['modbench.downloadedFile.queryInfo', DOWNLOADED_FILES],
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
  ['modbench.plugin.create', CREATE_PLUGIN],
  ['modbench.plugin.rename', RENAME_PLUGIN],
  ['modbench.record.open', OPEN_RECORD],
  ['modbench.modlist.gitInit', NO_INPUT],
  ['modbench.profile.switch', SWITCH_PROFILE],
  ['modbench.instance.refresh', NO_INPUT],
  ['modbench.instance.deploy', NO_INPUT],
  ['modbench.instance.purge', NO_INPUT],
  ['modbench.instance.moveToOverwrite', MOVE_TO_OVERWRITE],
  ['modbench.instance.logOut', NO_INPUT],
  ['modbench.mod.updateManifest', MODS_OR_EVERY_MOD],
  ['modbench.mod.checkForUpdates', MODS_OR_EVERY_MOD],
  ['modbench.mod.restoreFromManifest', MODS_OR_EVERY_MOD],
]);

type GestureOutcome = GestureResult<unknown>;

/** What deploy answers: the deploy task reads it whole. */
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

const toolName = (command: string): string =>
  command.replace(/^modbench\./, '').replaceAll('.', '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Claude Code shows the first 2,048 characters of a tool's description, and sends an input with no JSON type as a string. */
export const GESTURE_TOOLS = [...AGENT_GESTURES].map(([command, gesture]) => ({
  name: toolName(command),
  description: `Runs ${command}. ${gesture.takes}`.trim(),
  input: gesture.input,
  of: async (value: InstanceValue, mEdit: NameResolver, given: unknown, warn: (line: string) => void) => {
    const answer = await vscode.commands.executeCommand<GestureOutcome | DeployOutcome>(command, await gesture.callOf(value, given, mEdit));
    const outcome = isDeployed(answer) ? deployAnswered(answer) : answer;
    const refusal = refusalIn(outcome);
    if (refusal !== undefined) throw new Refusal(refusal, answerOf(outcome));
    if (outcome.applied) partialsIn(outcome).forEach(warn);
    return answerOf(outcome);
  },
}));
