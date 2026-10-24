// The FOMOD installer: runs a FOMOD's installer, answers its steps with the choices made, and lands the files those
// choices select, each where the reference installer puts it.

import { fork } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { delimiter, dirname, join, relative } from 'node:path';
import type { types } from '@nexusmods/fomod-installer-native';
import { copyTree, ensureDir, makeTempDir, ownTempPrefix, remove } from '../files';
import { errorMessage } from '../../ports/errorMessage';
import type { FomodKind } from '../gameFolder/releaseRoot';
import type { FomodAnswer, FomodGroupChoice, FomodLanded, FomodStepChoice } from '../instanceAdapter';
import type { ConditionFacts, EngineReport, EngineRequest } from './engineProtocol';

export type { ConditionFacts } from './engineProtocol';

/** Where the engine is: the script its process runs, and the folder of its add-on. */
export interface FomodEngine {
  readonly process: string;
  readonly folder: string;
}

interface FomodInstall {
  /** The folder that holds the FOMOD's `fomod` folder. */
  readonly root: string;
  /** The empty folder the selected files land in. */
  readonly into: string;
  readonly facts: ConditionFacts;
  readonly choices: readonly FomodStepChoice[];
}

/** The files landed, and each file the FOMOD names that its archive lacks; or why its installer cannot be read. */
type FomodInstalled = { readonly kind: 'installer'; readonly missing: readonly string[] } | { readonly kind: 'unreadable'; readonly why: string };

type Step = types.IInstallStep;
type Group = types.IGroup;
type Option = types.IPlugin;

type EngineRun =
  | { readonly kind: 'done'; readonly result: types.InstallResult | null; readonly refusal?: string; readonly unanswered: readonly string[] }
  | { readonly kind: 'failed'; readonly why: string };

const TAKES: Record<types.GroupType, string> = {
  SelectExactlyOne: 'exactly one', SelectAtMostOne: 'at most one', SelectAtLeastOne: 'at least one', SelectAll: 'all', SelectAny: 'any',
};

const OPTION_TYPES: Record<types.PluginType, string> = {
  Required: ' (required)', Recommended: ' (recommended)', NotUsable: ' (not usable)', CouldBeUsable: ' (could be usable)', Optional: '',
};

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

function selectionsFor(step: Step, choice: FomodStepChoice): EngineRequest[] {
  const groups = groupsOf(step);
  const unknown = choice.groups.map(({ group }) => group).filter((name) => !groups.some((group) => group.name === name));
  if (unknown.length > 0) throw new Error(`Step "${step.name}" has no group ${quoted(unknown)}. ${stepLines(step)}`);
  return groups.map((group) => ({
    kind: 'select',
    stepId: step.id,
    groupId: group.id,
    optionIds: picksFor(step, group, choice.groups.find((named) => named.group === group.name)).map((option) => option.id),
  }));
}

// Each step asked takes the first choice not yet taken that names it, so two steps of one name take one choice each.
function answerer(choices: readonly FomodStepChoice[]): (steps: readonly Step[], current: number) => EngineRequest[] {
  const taken = new Set<number>();
  const answered = new Set<number>();
  return (steps, current) => {
    const step = steps[current];
    if (step === undefined || answered.has(step.id)) return [];
    answered.add(step.id);
    const at = choices.findIndex((choice, i) => !taken.has(i) && choice.step === step.name);
    const choice = choices[at];
    if (choice === undefined) throw new Error(`The choices leave step "${step.name}" unanswered. ${stepLines(step)}`);
    taken.add(at);
    return [...selectionsFor(step, choice), { kind: 'continue', stepId: step.id }];
  };
}

const isReport = (value: unknown): value is EngineReport => typeof value === 'object' && value !== null && 'kind' in value;

function runEngine(engine: FomodEngine, install: EngineRequest, answer: ReturnType<typeof answerer>): Promise<EngineRun> {
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
  return new Promise((resolve) => {
    child.on('message', (report: unknown) => {
      if (!isReport(report)) return;
      switch (report.kind) {
        case 'step':
          if (refusal !== undefined) return;
          try {
            answer(report.steps, report.current).forEach(send);
          } catch (err) {
            refusal = errorMessage(err);
            send({ kind: 'cancel' });
          }
          return;
        case 'unanswered': unanswered.push(`${report.question}, which could not be read: ${report.why}`); return;
        case 'done': resolve({ kind: 'done', result: report.result, refusal, unanswered }); return;
        case 'failed': resolve({ kind: 'failed', why: report.message.split('\n')[0] ?? '' }); return;
      }
    });
    child.on('error', (err) => resolve({ kind: 'failed', why: err.message }));
    child.on('close', (code) => resolve({ kind: 'failed', why: stderr.trim().split('\n').pop() || `the FOMOD engine stopped with code ${code}` }));
    send(install);
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

// A path compared as Windows compares it, so a FOMOD written there finds its files and merges its folders.
const keyOf = (path: string): string => path.replaceAll('\\', '/').toLowerCase();

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
  for (const { destination } of instructions.filter(({ type }) => type === 'mkdir')) await ensureDir(destinationOf(destination));
  const copies = instructions.filter(({ type }) => type === 'copy').sort((a, b) => Number(a.priority) - Number(b.priority));
  for (const { source, destination } of copies) {
    const from = sources.get(keyOf(source));
    if (from === undefined) throw new Error(`The FOMOD installs "${source}", which its archive does not hold`);
    const to = destinationOf(destination);
    await ensureDir(dirname(to));
    await copyTree(join(root, from), to);
  }
}

/** Runs the FOMOD's installer over its choices and lands the files they select in `into`. Rejects, landing nothing,
 *  when the choices do not answer it, its module dependencies do not hold, or a fact its conditions read is unknown. */
async function installFomod(engine: FomodEngine, { root, into, facts, choices }: FomodInstall): Promise<FomodInstalled> {
  const files = await filesUnder(root);
  const run = await runEngine(engine, { kind: 'install', engineFolder: engine.folder, root, files, facts }, answerer(choices));
  if (run.kind === 'failed') return { kind: 'unreadable', why: run.why };
  if (run.refusal !== undefined) throw new Error(run.refusal);
  if (run.unanswered.length > 0) throw new Error(`The FOMOD's conditions read ${run.unanswered.join('; ')}.`);
  if (run.result === null) throw new Error('The FOMOD\'s installer stopped before it installed anything.');
  const { instructions } = run.result;
  const fatal = instructions.find(({ type, value }) => type === 'error' && value === 'fatal');
  if (fatal !== undefined) throw new Error(fatal.source.replaceAll('\n', '; '));
  await land(root, files, into, instructions);
  const missing = instructions.filter(({ type }) => type === 'error').map(({ source }) => /"(.*)"$/.exec(source)?.[1] ?? source);
  return { kind: 'installer', missing };
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
