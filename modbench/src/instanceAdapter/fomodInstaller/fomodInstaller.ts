// The FOMOD installer: runs a FOMOD's installer, answers its steps with the choices made, and lands the files those
// choices select, each where the reference installer puts it.

import { fork } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { types } from '@nexusmods/fomod-installer-native';
import { copyTree, ensureDir, makeTempDir, ownTempPrefix, remove, textIfUtf8, write } from '../files';
import { moduleConfigForEngine } from './moduleConfig';
import { errorMessage } from '../../ports/errorMessage';
import type { FomodKind } from '../gameFolder/releaseRoot';
import type { FomodAnswer, FomodGroupChoice, FomodLanded, FomodStepChoice } from '../instanceAdapter';
import { isReport, type ConditionFacts, type EngineRequest } from './engineProtocol';

export type { ConditionFacts } from './engineProtocol';

/** Where the engine is: the script its process runs, and the folder of its add-on; and how long, in milliseconds, it
 *  may say nothing before it is stopped. */
export interface FomodEngine {
  readonly process: string;
  readonly folder: string;
  readonly silence: number;
}

interface FomodInstall {
  readonly root: string;
  readonly into: string;
  readonly facts: ConditionFacts;
  readonly choices: readonly FomodStepChoice[];
}

type FomodInstalled = Extract<FomodLanded, { readonly kind: 'installer' }> | { readonly kind: 'unreadable'; readonly why: string };

type Step = types.IInstallStep;
type Group = types.IGroup;
type Option = types.IPlugin;

type EngineRun =
  | { readonly kind: 'done'; readonly result: types.InstallResult | null; readonly refusal?: string; readonly unanswered: readonly string[] }
  | { readonly kind: 'unreadable'; readonly why: string };

interface Answerer {
  (steps: readonly Step[], current: number): EngineRequest;
  /** The choices that no step the installer showed took. */
  readonly untaken: () => readonly FomodStepChoice[];
}

const TAKES: Record<types.GroupType, string> = {
  SelectExactlyOne: 'exactly one', SelectAtMostOne: 'at most one', SelectAtLeastOne: 'at least one', SelectAll: 'all', SelectAny: 'any',
};

const OPTION_TYPES: Record<types.PluginType, string> = {
  Required: ' (required)', Recommended: ' (recommended)', NotUsable: ' (not usable)', CouldBeUsable: ' (could be usable)', Optional: '',
};

// The engine's one word for a source its archive lacks; it says nothing else that is not passed on as it says it.
const MISSING_SOURCE = /^Source doesn't match any files: "(.*)"$/;

const MODULE_CONFIG = 'fomod/moduleconfig.xml';

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

const groupsOf = (step: Step): readonly Group[] => step.optionalFileGroups?.group ?? [];

const groupLine = (group: Group): string =>
  `group "${group.name}" takes ${TAKES[group.type]} of ${group.options.map((option) => `"${option.name}"${OPTION_TYPES[option.type]}`).join(', ')}`;

const stepLines = (step: Step): string => `Step "${step.name}": ${groupsOf(step).map(groupLine).join('; ')}.`;

const holdsPick = (type: types.GroupType, count: number, total: number): boolean => {
  switch (type) {
    case 'SelectExactlyOne': return count === 1;
    case 'SelectAtMostOne': return count <= 1;
    case 'SelectAtLeastOne': return count >= 1;
    case 'SelectAll': return count === total;
    case 'SelectAny': return true;
  }
};

// The options a group takes for the choice: those named, each required one, and all of a group that takes all.
function picksFor(step: Step, group: Group, choice: FomodGroupChoice | undefined): readonly Option[] {
  const named = choice?.options ?? [];
  const unknown = named.filter((name) => !group.options.some((option) => option.name === name));
  if (unknown.length > 0) throw new Error(`Group "${group.name}" of step "${step.name}" has no option ${quoted(unknown)}. ${stepLines(step)}`);
  const picked = group.options.filter((option) => named.includes(option.name));
  const unusable = picked.filter((option) => option.type === 'NotUsable');
  if (unusable.length > 0) throw new Error(`${quoted(unusable.map((option) => option.name))} cannot be picked. ${stepLines(step)}`);
  const picks = group.options.filter((option) => picked.includes(option) || option.type === 'Required' || group.type === 'SelectAll');
  if (!holdsPick(group.type, picks.length, group.options.length)) {
    throw new Error(`Group "${group.name}" of step "${step.name}" takes ${TAKES[group.type]}, and the choices pick ${picks.length}. ${stepLines(step)}`);
  }
  return picks;
}

function answerFor(step: Step, choice: FomodStepChoice): EngineRequest {
  const groups = groupsOf(step);
  const unknown = choice.groups.map(({ group }) => group).filter((name) => !groups.some((group) => group.name === name));
  if (unknown.length > 0) throw new Error(`Step "${step.name}" has no group ${quoted(unknown)}. ${stepLines(step)}`);
  const selections = groups.map((group) => ({
    groupId: group.id,
    optionIds: picksFor(step, group, choice.groups.find((named) => named.group === group.name)).map((option) => option.id),
  }));
  return { kind: 'answer', stepId: step.id, selections };
}

// Each step shown takes the first untaken choice of its name. The engine reports a step once per move to it, so a
// step reported again is one it would not leave.
function answerer(choices: readonly FomodStepChoice[]): Answerer {
  const taken = new Set<number>();
  const answered = new Set<number>();
  const answer = (steps: readonly Step[], current: number): EngineRequest => {
    const step = steps[current];
    if (step === undefined) throw new Error(`The installer moved to step ${current} of ${steps.length}.`);
    if (answered.has(step.id)) throw new Error(`The installer would not leave step "${step.name}" on the choices given. ${stepLines(step)}`);
    answered.add(step.id);
    const at = choices.findIndex((choice, i) => !taken.has(i) && choice.step === step.name);
    const choice = choices[at];
    if (choice === undefined) throw new Error(`The choices leave step "${step.name}" unanswered. ${stepLines(step)}`);
    taken.add(at);
    return answerFor(step, choice);
  };
  return Object.assign(answer, { untaken: () => choices.filter((_, i) => !taken.has(i)) });
}

const engineFault = (why: string): Error => new Error(`The FOMOD engine could not run: ${why}`);

function runEngine(engine: FomodEngine, install: EngineRequest, answer: Answerer): Promise<EngineRun> {
  const child = fork(engine.process, [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LD_LIBRARY_PATH: [engine.folder, process.env.LD_LIBRARY_PATH].filter((dir) => dir !== undefined && dir !== '').join(delimiter),
    },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const send = (request: EngineRequest): void => {
    child.send(request);
  };
  const unanswered: string[] = [];
  let refusal: string | undefined;
  return new Promise((resolve, reject) => {
    let silence: NodeJS.Timeout | undefined;
    const settle = (settled: () => void): void => {
      clearTimeout(silence);
      settled();
    };
    const fail = (why: string): void => settle(() => reject(engineFault(why)));
    const heard = (): void => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        child.kill();
        fail(`it said nothing for ${engine.silence} ms`);
      }, engine.silence);
    };
    child.on('message', (report: unknown) => {
      heard();
      if (!isReport(report)) return;
      switch (report.kind) {
        case 'step':
          if (refusal !== undefined) return;
          try {
            send(answer(report.steps, report.current));
          } catch (err) {
            refusal = errorMessage(err);
            send({ kind: 'cancel' });
          }
          return;
        case 'unanswered': unanswered.push(`${report.question}, which could not be read: ${report.why}`); return;
        case 'done': settle(() => resolve({ kind: 'done', result: report.result, refusal, unanswered })); return;
        case 'failed': settle(() => resolve({ kind: 'unreadable', why: report.message.split('\n')[0] ?? '' })); return;
        case 'broken': fail(report.message); return;
      }
    });
    child.on('error', (err) => fail(err.message));
    child.on('close', (code) => fail(stderr.trim().split('\n').pop() || `it stopped with code ${code}`));
    heard();
    send(install);
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

// A path compared as Windows compares it, so a FOMOD written there finds its files and merges its folders.
const keyOf = (path: string): string => path.replaceAll('\\', '/').toLowerCase();

// The engine reads the config from a folder of its own, so the release keeps its own. A config that is not UTF-8 it
// reads as the release holds it.
async function scriptFolder(root: string, files: readonly string[]): Promise<{ readonly root: string; dispose(): Promise<void> }> {
  const config = files.find((file) => keyOf(file) === MODULE_CONFIG);
  const text = config === undefined ? undefined : await textIfUtf8(join(root, config));
  if (text === undefined) return { root, dispose: () => Promise.resolve() };
  const keys = files.map(keyOf);
  const holds = (folder: string): boolean => {
    const key = keyOf(folder).replace(/\/+$/, '');
    return key === '' || keys.some((file) => file.startsWith(`${key}/`));
  };
  const script = await makeTempDir(ownTempPrefix(root, 'fomodScript'));
  await ensureDir(join(script, 'fomod'));
  await write(join(script, 'fomod', 'ModuleConfig.xml'), moduleConfigForEngine(text, holds));
  return { root: script, dispose: () => remove(script) };
}

const isOutside = (folder: string, path: string): boolean => {
  const within = relative(folder, path);
  return within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within);
};

async function land(root: string, files: readonly string[], into: string, instructions: readonly types.InstallInstruction[]): Promise<void> {
  const sources = new Map(files.map((file) => [keyOf(file), file]));
  const spelled = new Map<string, string>();
  const destinationOf = (path: string): string => {
    let at = '';
    for (const segment of path.split(/[\\/]/).filter((part) => part !== '')) {
      const asNamed = at === '' ? segment : `${at}/${segment}`;
      at = spelled.get(keyOf(asNamed)) ?? asNamed;
      spelled.set(keyOf(asNamed), at);
    }
    return join(into, at);
  };
  const placed = instructions.filter(({ type }) => type === 'mkdir' || type === 'copy')
    .sort((a, b) => Number(a.priority) - Number(b.priority))
    .map((instruction) => ({ ...instruction, to: destinationOf(instruction.destination) }));
  const outside = placed.filter(({ to }) => isOutside(into, to)).map(({ destination }) => destination);
  if (outside.length > 0) throw new Error(`The FOMOD installs to ${quoted(outside)}, outside the mod's folder.`);
  for (const { to } of placed.filter(({ type }) => type === 'mkdir')) await ensureDir(to);
  for (const { source, to } of placed.filter(({ type }) => type === 'copy')) {
    const from = sources.get(keyOf(source));
    if (from === undefined) throw new Error(`The FOMOD installs "${source}", which its archive does not hold`);
    await ensureDir(dirname(to));
    await copyTree(join(root, from), to);
  }
}

// Rejects, landing nothing, when the choices do not answer the installer, its module dependencies do not hold, a
// fact its conditions read is unknown, or it installs outside the mod's folder.
async function installFomod(engine: FomodEngine, { root, into, facts, choices }: FomodInstall): Promise<FomodInstalled> {
  const files = await filesUnder(root);
  const script = await scriptFolder(root, files);
  const answer = answerer(choices);
  const run = await runEngine(engine, { kind: 'install', engineFolder: engine.folder, root: script.root, files, facts }, answer)
    .finally(() => script.dispose());
  if (run.kind === 'unreadable') return run;
  if (run.refusal !== undefined) throw new Error(run.refusal);
  if (run.unanswered.length > 0) throw new Error(`The FOMOD's conditions read ${run.unanswered.join('; ')}.`);
  if (run.result === null) throw new Error('The FOMOD\'s installer stopped before it installed anything.');
  const untaken = answer.untaken().map(({ step }) => step);
  if (untaken.length > 0) throw new Error(`The installer shows no step ${quoted(untaken)} for the choices given.`);
  const { instructions } = run.result;
  const fatal = instructions.find(({ type, value }) => type === 'error' && value === 'fatal');
  if (fatal !== undefined) throw new Error(fatal.source.replaceAll('\n', '; '));
  await land(root, files, into, instructions);
  const errors = instructions.filter(({ type }) => type === 'error').map(({ source }) => ({ source, missing: MISSING_SOURCE.exec(source)?.[1] }));
  return {
    kind: 'installer',
    missing: errors.flatMap(({ missing }) => missing ?? []),
    notes: errors.flatMap(({ source, missing }) => (missing === undefined ? [source] : [])),
  };
}

/** Where a release that holds a FOMOD lands its files from, and how: the folder its installer filled, inside the
 *  release's own, or the release as it is when the installer does not run, and why. */
export async function fomodLanding(
  engine: FomodEngine, release: { readonly root: string; readonly fomod: FomodKind }, answer: FomodAnswer | undefined, facts: () => Promise<ConditionFacts>,
): Promise<{ readonly root: string; readonly fomod: FomodLanded }> {
  const plainCopy = (why: string) => ({ root: release.root, fomod: { kind: 'plainCopy', why } as const });
  if (release.fomod === 'script') return plainCopy('its installer is a script, which Modbench does not run');
  if (answer === undefined) return plainCopy('no choices were given for its steps');
  if (answer.kind === 'manual') return plainCopy('Manual was asked for');
  const into = await makeTempDir(ownTempPrefix(release.root, 'fomod'));
  const installed = await installFomod(engine, { root: release.root, into, facts: await facts(), choices: answer.steps });
  if (installed.kind === 'installer') return { root: into, fomod: installed };
  await remove(into);
  return plainCopy(`its installer cannot be read: ${installed.why}`);
}
