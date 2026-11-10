// The FOMOD installer: runs a FOMOD's installer, answers its steps with the choices made, and lands the files those
// choices select, each where the reference installer puts it.

import { fork } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { types } from '@nexusmods/fomod-installer-native';
import { copyTree, ensureDir, makeTempDir, remove, write } from '../files';
import { ownTempPrefix } from '../../repositoriesLib/wholeWrites';
import { releaseXmlText } from './releaseXml';
import { moduleConfigForEngine } from './moduleConfig';
import { aboutIn, NO_ABOUT, type About } from './releaseAbout';
import { keyOf, resolverIn } from './releasePaths';
import { errorMessage } from '../../ports/errorMessage';
import type { Log } from '../../ports/log';
import type { FomodKind } from '../gameFolder/releaseRoot';
import { withImages, type FomodState, type ReleaseImage } from '../../wire/fomodPage';
import type { FomodAnswer, FomodGroupChoice, FomodLanded, FomodStepChoice } from '../instanceAdapter';
import { deathWhy } from './engineDeath';
import { isReport, type ConditionFacts, type EngineReport, type EngineRequest } from './engineProtocol';

export type { ConditionFacts } from './engineProtocol';

/** Where the engine is: the script its process runs, and the folder of its add-on; and how long, in milliseconds, it
 *  may say nothing before it is stopped; and where its stderr goes when it fails. */
export interface FomodEngine {
  readonly process: string;
  readonly folder: string;
  readonly silence: number;
  readonly log: Log;
}

interface FomodInstall {
  readonly root: string;
  readonly into: string;
  readonly facts: ConditionFacts;
  readonly driver: Driver;
}

type Stopped = { readonly kind: 'manual' } | { readonly kind: 'cancelled' };

type FomodInstalled = Extract<FomodLanded, { readonly kind: 'installer' }> | Stopped | { readonly kind: 'unreadable' | 'refused'; readonly why: string };

type Step = types.IInstallStep;
type Group = types.IGroup;
type Option = types.IPlugin;

type EngineRun =
  | { readonly kind: 'done'; readonly result: types.InstallResult | null; readonly refusal?: string }
  | { readonly kind: 'unreadable'; readonly why: string };

type StepReport = Extract<EngineReport, { readonly kind: 'step' }>;

// Who answers the installer: the choices an agent gave, or the user on a page.
interface Driver {
  readonly waitsOnUser: boolean;
  // Called before the installer runs; `send` carries answers that come when they come.
  readonly attach: (send: (request: EngineRequest) => void) => void;
  readonly opened: (module: string, image: string) => void;
  // Called once the release's files are listed, before the installer runs.
  readonly released: (release: { readonly root: string; readonly files: readonly string[] }) => Promise<void>;
  // The requests that answer the installer as it stands. Throws when the installer cannot be left.
  readonly step: (report: StepReport) => readonly EngineRequest[];
  // Resolves when the installer, which finished with no step shown, may install.
  readonly finish: () => Promise<void>;
  readonly confirmMissing: (missing: readonly string[]) => Promise<boolean>;
  readonly ended: () => Stopped | undefined;
  // The steps of the choices that no step the installer showed took. Throws where they refuse the install.
  readonly unused: () => readonly string[];
}

const TAKES: Record<types.GroupType, string> = {
  SelectExactlyOne: 'exactly one', SelectAtMostOne: 'at most one', SelectAtLeastOne: 'at least one', SelectAll: 'all', SelectAny: 'any',
};

const OPTION_TYPES: Record<types.PluginType, string> = {
  Required: ' (required)', Recommended: ' (recommended)', NotUsable: ' (not usable)', CouldBeUsable: ' (could be usable)', Optional: '',
};

const slashed = (path: string): string => path.replaceAll('\\', '/');

// The engine's one word for a source its archive lacks; it says nothing else that is not passed on as it says it.
const MISSING_SOURCE = /^Source doesn't match any files: "(.*)"$/;

const MODULE_CONFIG = 'fomod/moduleconfig.xml';

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

const groupsOf = (step: Step): readonly Group[] => step.optionalFileGroups?.group ?? [];

// The installer shows a name without the spaces around it, so a choice names it so.
const shown = (name: string): string => name.trim();

const sameName = (one: string, other: string): boolean => shown(one) === shown(other);

const refuseAmbiguous = (kind: string, names: readonly string[], used: readonly string[], where: string): void => {
  const ambiguous = used.filter((name) => names.filter((one) => sameName(one, name)).length > 1);
  if (ambiguous.length > 0) throw new Error(`${where} has more than one ${kind} named ${quoted(ambiguous.map(shown))}, so a choice cannot name one.`);
};

const described = (option: Option): string => {
  const description = option.description.trim();
  return description === '' ? '' : `: ${JSON.stringify(description)}`;
};

const groupLine = (group: Group, about: (option: Option) => string): string =>
  `group "${shown(group.name)}" takes ${TAKES[group.type]} of ${group.options.map((option) => `"${shown(option.name)}"${OPTION_TYPES[option.type]}${about(option)}`).join(', ')}`;

const stepLines = (step: Step, about: (option: Option) => string = () => ''): string =>
  `Step "${shown(step.name)}": ${groupsOf(step).map((group) => groupLine(group, about)).join('; ')}.`;

const holdsPick = (type: types.GroupType, count: number, total: number): boolean => {
  switch (type) {
    case 'SelectExactlyOne': return count === 1;
    case 'SelectAtMostOne': return count <= 1;
    case 'SelectAtLeastOne': return count >= 1;
    case 'SelectAll': return count === total;
    case 'SelectAny': return true;
  }
};

function optionsNamed(step: Step, group: Group, named: readonly string[]): readonly Option[] {
  refuseAmbiguous('option', group.options.map((option) => option.name), named, `Group "${shown(group.name)}" of step "${shown(step.name)}"`);
  const unknown = named.filter((name) => !group.options.some((option) => sameName(option.name, name)));
  if (unknown.length > 0) throw new Error(`Group "${shown(group.name)}" of step "${shown(step.name)}" has no option ${quoted(unknown)}. ${stepLines(step)}`);
  return group.options.filter((option) => named.some((name) => sameName(option.name, name)));
}

// The options a group takes for the choice: those named, each required one, and all of a group that takes all.
function picksFor(step: Step, group: Group, choice: FomodGroupChoice | undefined): readonly Option[] {
  const picked = optionsNamed(step, group, choice?.options ?? []);
  const unusable = picked.filter((option) => option.type === 'NotUsable');
  if (unusable.length > 0) throw new Error(`${quoted(unusable.map((option) => shown(option.name)))} cannot be picked. ${stepLines(step)}`);
  const picks = group.options.filter((option) => picked.includes(option) || option.type === 'Required' || group.type === 'SelectAll');
  if (!holdsPick(group.type, picks.length, group.options.length)) {
    throw new Error(`Group "${shown(group.name)}" of step "${shown(step.name)}" takes ${TAKES[group.type]}, and the choices pick ${picks.length}. ${stepLines(step)}`);
  }
  return picks;
}

function groupsNamed(step: Step, choice: FomodStepChoice): readonly (readonly [Group, FomodGroupChoice | undefined])[] {
  const groups = groupsOf(step);
  refuseAmbiguous('group', groups.map((group) => group.name), choice.groups.map(({ group }) => group), `Step "${shown(step.name)}"`);
  const unknown = choice.groups.map(({ group }) => group).filter((name) => !groups.some((group) => sameName(group.name, name)));
  if (unknown.length > 0) throw new Error(`Step "${shown(step.name)}" has no group ${quoted(unknown)}. ${stepLines(step)}`);
  return groups.map((group) => [group, choice.groups.find((named) => sameName(named.group, group.name))]);
}

const selectionOf = (step: Step, group: Group, choice: FomodGroupChoice | undefined): EngineRequest =>
  ({ kind: 'select', stepId: step.id, selection: { groupId: group.id, optionIds: picksFor(step, group, choice).map((option) => option.id) } });

const answerFor = (step: Step, choice: FomodStepChoice): EngineRequest[] => [
  ...groupsNamed(step, choice).map(([group, named]) => selectionOf(step, group, named)),
  { kind: 'continue', forward: true, stepId: step.id },
];

// mods-fomod.md, Groups and options, story 4.
const seedFor = (step: Step, choice: FomodStepChoice): EngineRequest[] =>
  groupsNamed(step, choice).flatMap(([group, named]) => (named === undefined ? [] : [selectionOf(step, group, named)]));

// Each step shown takes the first untaken choice of its name.
function choiceTaker(choices: readonly FomodStepChoice[]): { readonly take: (step: Step) => FomodStepChoice | undefined; readonly untaken: () => readonly string[] } {
  const taken = new Set<number>();
  return {
    take: (step) => {
      const at = choices.findIndex((choice, i) => !taken.has(i) && sameName(choice.step, step.name));
      if (at === -1) return undefined;
      taken.add(at);
      return choices[at];
    },
    untaken: () => choices.flatMap(({ step }, i) => (taken.has(i) ? [] : [step])),
  };
}

// The engine reports every step, shown or not, so each name a choice gives is checked before the page opens.
function refuseNamesNotHeld(steps: readonly Step[], choices: readonly FomodStepChoice[]): void {
  for (const choice of choices) {
    const step = steps.find((one) => sameName(one.name, choice.step));
    if (step === undefined) throw new Error(`The installer has no step "${shown(choice.step)}". Its steps are ${quoted(steps.map((one) => shown(one.name)))}.`);
    for (const [group, named] of groupsNamed(step, choice)) optionsNamed(step, group, named?.options ?? []);
  }
}

const UNATTENDED = {
  waitsOnUser: false,
  attach: () => undefined,
  opened: () => undefined,
  released: () => Promise.resolve(),
  finish: () => Promise.resolve(),
  ended: () => undefined,
};

// The engine reports a step once per move to it, so a step reported again is one it would not leave.
function choosing({ steps: choices, installAnyway }: Extract<FomodAnswer, { readonly kind: 'choices' }>): Driver {
  const taker = choiceTaker(choices);
  const answered = new Set<number>();
  const answer = ({ steps, current, cause }: StepReport): readonly EngineRequest[] => {
    if (cause === 'select') return [];
    const step = steps[current];
    if (step === undefined) throw new Error(`The installer moved to step ${current} of ${steps.length}.`);
    if (answered.has(step.id)) throw new Error(`The installer would not leave step "${shown(step.name)}" on the choices given. ${stepLines(step)}`);
    answered.add(step.id);
    const choice = taker.take(step);
    if (choice === undefined) {
      throw new Error(`The choices leave step "${shown(step.name)}" unanswered. ${stepLines(step, described)} Put it to the user, or request it again with installer to open the installer for them.`);
    }
    return answerFor(step, choice);
  };
  const confirmMissing = (missing: readonly string[]): Promise<boolean> => {
    if (installAnyway !== true) throw new Error(`The FOMOD names files its archive does not hold: ${missing.join(', ')}. Request it again with install anyway to land it without them.`);
    return Promise.resolve(true);
  };
  const unused = (): readonly string[] => {
    const untaken = taker.untaken();
    if (untaken.length > 0) throw new Error(`The installer shows no step ${quoted(untaken)} for the choices given.`);
    return [];
  };
  return { ...UNATTENDED, step: answer, confirmMissing, unused };
}

// The user answers on a page. An installer with no step to show finishes at once, and the page then shows its header
// and Install alone.
function conversing({ dialog, steps: choices }: Extract<FomodAnswer, { readonly kind: 'dialog' }>): Driver {
  const taker = choiceTaker(choices);
  const seeded = new Set<number>();
  let namesChecked = false;
  let module = '';
  let headerImage = '';
  let about: About = NO_ABOUT;
  let folder = '';
  let imageIn = resolverIn([]);
  let shown = false;
  let ended: Stopped | undefined;
  let release: (() => void) | undefined;
  const stateOf = (steps: readonly Step[], current: number): FomodState<ReleaseImage> =>
    withImages({ module, ...about, image: headerImage, steps, current }, (image) => {
      const path = imageIn(image);
      return path === undefined ? undefined : { path };
    });
  return {
    waitsOnUser: true,
    attach: (send) => dialog.onMove((move) => {
      if (move.kind === 'manual' || move.kind === 'cancel') {
        ended = { kind: move.kind === 'manual' ? 'manual' : 'cancelled' };
        dialog.asking(false);
      }
      if (release !== undefined) {
        release();
        release = undefined;
        return;
      }
      switch (move.kind) {
        case 'select': send({ kind: 'select', stepId: move.stepId, selection: { groupId: move.groupId, optionIds: move.optionIds } }); return;
        case 'continue': send({ kind: 'continue', forward: move.forward, stepId: move.stepId }); return;
        case 'manual':
        case 'cancel': send({ kind: 'cancel' }); return;
      }
    }),
    opened: (name, image) => {
      module = name;
      headerImage = image;
    },
    released: async ({ root, files }) => {
      folder = root;
      imageIn = resolverIn(files);
      about = await aboutIn(root, files);
    },
    step: ({ steps, current, cause }) => {
      if (!namesChecked) refuseNamesNotHeld(steps, choices);
      namesChecked = true;
      const step = steps[current];
      if (cause === 'move' && step !== undefined && !seeded.has(step.id)) {
        seeded.add(step.id);
        const choice = taker.take(step);
        const seed = choice === undefined ? [] : seedFor(step, choice);
        if (seed.length > 0) return seed;
      }
      shown = true;
      dialog.show(stateOf(steps, current), folder);
      dialog.asking(true);
      return [];
    },
    finish: () => {
      if (shown) {
        dialog.asking(false);
        return Promise.resolve();
      }
      dialog.show(stateOf([], 0), folder);
      dialog.asking(true);
      return new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => dialog.asking(false));
    },
    confirmMissing: async (missing) => {
      dialog.asking(true);
      try {
        return await dialog.confirmMissing(missing);
      } finally {
        dialog.asking(false);
      }
    },
    ended: () => ended,
    unused: taker.untaken,
  };
}

const XML_FAULT = /\(Xml_MessageWithErrorPosition, \w+, (\d+), (\d+)\)/;

// The native build strips .NET's message text, so a malformed config arrives as resource keys and a position.
const unreadableWhy = (message: string): string => {
  const at = XML_FAULT.exec(message);
  return at === null ? message.split('\n')[0] ?? '' : `fomod/ModuleConfig.xml is not well-formed XML, at line ${at[1]}, column ${at[2]}`;
};

const engineFault = (why: string): Error => new Error(`The FOMOD engine could not run: ${why}`);

const conditionsRead = (unanswered: ReadonlySet<string>): string => `The FOMOD's conditions read ${[...unanswered].join('; ')}.`;

function runEngine(engine: FomodEngine, install: EngineRequest, driver: Driver): Promise<EngineRun> {
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
  const unanswered = new Set<string>();
  let refusal: string | undefined;
  return new Promise((resolve, reject) => {
    let silence: NodeJS.Timeout | undefined;
    let over = false;
    const settle = (settled: () => void): void => {
      over = true;
      clearTimeout(silence);
      settled();
    };
    let silent: string | undefined;
    const logStderr = (): void => {
      if (stderr.trim() !== '') engine.log.error(`The FOMOD engine's stderr:\n${stderr.trim()}`);
    };
    const fail = (why: string): void => {
      if (over) return;
      logStderr();
      settle(() => reject(engineFault(why)));
    };
    const unreadable = (why: string): void => {
      if (over) return;
      logStderr();
      settle(() => resolve({ kind: 'unreadable', why }));
    };
    const heard = (): void => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        silent = `it stopped answering for ${engine.silence} ms`;
        child.kill('SIGKILL');
      }, engine.silence);
    };
    const send = (request: EngineRequest): void => {
      if (over) return;
      child.send(request);
      heard();
    };
    child.on('message', (report: unknown) => {
      heard();
      if (!isReport(report)) return;
      switch (report.kind) {
        case 'dialog': driver.opened(report.module, report.image); return;
        case 'step':
          if (refusal !== undefined) return;
          if (unanswered.size > 0) {
            refusal = conditionsRead(unanswered);
            send({ kind: 'cancel' });
            return;
          }
          if (driver.waitsOnUser) clearTimeout(silence);
          try {
            for (const request of driver.step(report)) send(request);
          } catch (err) {
            refusal = errorMessage(err);
            send({ kind: 'cancel' });
          }
          return;
        case 'unanswered': unanswered.add(`${report.question}, which could not be read: ${report.why}`); return;
        case 'done':
          settle(() => resolve({ kind: 'done', result: report.result, refusal: refusal ?? (unanswered.size > 0 ? conditionsRead(unanswered) : undefined) }));
          return;
        case 'failed': settle(() => resolve({ kind: 'unreadable', why: unreadableWhy(report.message) })); return;
        case 'broken': fail(report.message); return;
      }
    });
    child.on('error', (err) => fail(err.message));
    child.on('close', (code, signal) => unreadable(silent ?? deathWhy(stderr, code, signal)));
    driver.attach(send);
    heard();
    send(install);
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

// The engine reads the config from a folder of its own, so the release keeps its own. It reads a UTF-8 copy whatever
// encoding its declaration names.
async function scriptFolder(root: string, files: readonly string[]): Promise<{ readonly root: string; dispose(): Promise<void> }> {
  const config = files.find((file) => keyOf(file) === MODULE_CONFIG);
  const text = config === undefined ? undefined : await releaseXmlText(join(root, config));
  if (config === undefined || text === undefined) return { root, dispose: () => Promise.resolve() };
  const keys = files.map(keyOf);
  const holds = (folder: string): boolean => {
    const key = keyOf(folder).replace(/\/+$/, '');
    return key === '' || keys.some((file) => file.startsWith(`${key}/`));
  };
  const script = await makeTempDir(ownTempPrefix(root, 'fomodScript'));
  await ensureDir(join(script, dirname(config)));
  await write(join(script, config), moduleConfigForEngine(text, holds));
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
  const outside = placed.filter(({ to }) => isOutside(into, to)).map(({ destination }) => slashed(destination));
  if (outside.length > 0) throw new Error(`The FOMOD installs to ${quoted(outside)}, outside the mod's folder.`);
  for (const { to } of placed.filter(({ type }) => type === 'mkdir')) await ensureDir(to);
  for (const { source, to } of placed.filter(({ type }) => type === 'copy')) {
    const from = sources.get(keyOf(source));
    if (from === undefined) throw new Error(`The FOMOD installs "${source}", which its archive does not hold`);
    await ensureDir(dirname(to));
    await copyTree(join(root, from), to);
  }
}

async function installFomod(engine: FomodEngine, { root, into, facts, driver }: FomodInstall): Promise<FomodInstalled> {
  const files = await filesUnder(root);
  await driver.released({ root, files });
  const script = await scriptFolder(root, files);
  const run = await runEngine(engine, { kind: 'install', engineFolder: engine.folder, root: script.root, files, facts }, driver)
    .finally(() => script.dispose());
  if (run.kind === 'unreadable') return run;
  if (run.refusal !== undefined) throw new Error(run.refusal);
  const stopped = driver.ended();
  if (stopped !== undefined) return stopped;
  if (run.result === null) throw new Error('The FOMOD\'s installer stopped before it installed anything.');
  const unused = driver.unused();
  const { instructions } = run.result;
  const fatal = instructions.find(({ type, value }) => type === 'error' && value === 'fatal');
  if (fatal !== undefined) return { kind: 'refused', why: fatal.source.replaceAll('\n', '; ') };
  await driver.finish();
  const errors = instructions.filter(({ type }) => type === 'error').map(({ source }) => ({ source, missing: MISSING_SOURCE.exec(source)?.[1] }));
  const missing = errors.flatMap(({ missing: each }) => (each === undefined ? [] : [slashed(each)]));
  const finished = driver.ended() ?? (missing.length > 0 && !(await driver.confirmMissing(missing)) ? { kind: 'cancelled' as const } : undefined);
  if (finished !== undefined) return finished;
  await land(root, files, into, instructions);
  const notes = errors.flatMap(({ source, missing: each }) => (each === undefined ? [source] : []));
  return { kind: 'installer', missing, notes, ...(unused.length > 0 && { unused }) };
}

const driverFor = (answer: Extract<FomodAnswer, { readonly kind: 'choices' | 'dialog' }>): Driver =>
  (answer.kind === 'choices' ? choosing(answer) : conversing(answer));

const SCRIPT = 'its installer is a script, which Modbench does not run';
const MANUAL_ASKED = 'Manual was asked for';

export type FomodLanding = { readonly kind: 'landing'; readonly root: string; readonly fomod: FomodLanded } | { readonly kind: 'cancelled' };

/** Where a release that holds a FOMOD lands its files from, and how: the folder its installer filled, or the release
 *  as it is; or none, because the user cancelled. */
export async function fomodLanding(
  engine: FomodEngine, release: { readonly root: string; readonly fomod: FomodKind }, answer: FomodAnswer | undefined, facts: () => Promise<ConditionFacts>,
): Promise<FomodLanding> {
  const asIs = (why: string): FomodLanding => ({ kind: 'landing', root: release.root, fomod: { kind: 'plainCopy', why } });
  if (answer?.kind === 'manual') return asIs(MANUAL_ASKED);
  const refused = async (why: string): Promise<FomodLanding> => {
    if (answer?.kind !== 'dialog') throw new Error(`${why}. Request it again with manual to install it as a plain copy.`);
    const { dialog } = answer;
    dialog.asking(true);
    try {
      return await dialog.refuse(why) === 'manual' ? asIs(MANUAL_ASKED) : { kind: 'cancelled' };
    } finally {
      dialog.asking(false);
    }
  };
  if (release.fomod === 'script') return refused(SCRIPT);
  if (answer === undefined) return refused('no choices were given for its steps');
  const into = await makeTempDir(ownTempPrefix(release.root, 'fomod'));
  try {
    const installed = await installFomod(engine, { root: release.root, into, facts: await facts(), driver: driverFor(answer) });
    if (installed.kind === 'installer') return { kind: 'landing', root: into, fomod: installed };
    await remove(into);
    if (installed.kind === 'cancelled') return installed;
    if (installed.kind === 'manual') return asIs(MANUAL_ASKED);
    return await refused(installed.kind === 'refused' ? installed.why : `its installer cannot be read: ${installed.why}`);
  } finally {
    if (answer.kind === 'dialog') answer.dialog.close();
  }
}
