import { errorMessage } from '../ports/errorMessage';
import type { Instance } from '../instanceLoader/instance';
import { WrittenFiles } from '../instanceLoader/writtenFiles';
import { collectingWrites } from '../instanceLoader/ambientWrites';
import { pausableProgress, type Progress } from './pausableProgress';
import { Refusal } from './refusal';
import type { Reporter } from '../ports/reporter';

export type RecordWrite = (command: () => Promise<void>) => Promise<void>;

type OneChange = <T>(work: () => Promise<T>) => Promise<T>;

let oneChange: OneChange | undefined;

/** Sets the scope that collects the writes of the work it runs and tells the Instance loader of them once the work settles. */
export function surfaceOneChange(on: OneChange): { dispose: () => void } {
  oneChange = on;
  return { dispose: () => { oneChange = undefined; } };
}

let changesRunning = 0;
const waitingForChanges = new Set<() => Promise<void>>();

/** Runs `task` now, or once no change is running: a repair is a write, and judges the value holding the whole change.
 *  The caller does not wait: the change's own read waits on its subscribers. */
export function whenNoChangeIsRunning(task: () => Promise<void>): Promise<void> {
  if (changesRunning === 0) return task();
  waitingForChanges.add(task);
  return Promise.resolve();
}

/** Hands the Instance loader every file `work` wrote in one tell once it ends, so no subscriber sees it half done. */
export async function handingOneChange<T>(instance: Pick<Instance, 'refresh'>, work: (written: WrittenFiles) => Promise<T>): Promise<T> {
  const written = new WrittenFiles();
  changesRunning++;
  try {
    return await (oneChange ?? ((run) => run()))(() => collectingWrites(written, () => work(written)));
  } finally {
    try {
      await refreshWritten(instance, written);
    } finally {
      changesRunning--;
      if (changesRunning === 0) {
        const waiting = [...waitingForChanges];
        waitingForChanges.clear();
        for (const task of waiting) void task();
      }
    }
  }
}

/** Runs `command` under the view's progress, which a command that waits on a person closes through the `Progress` it is given. */
export async function runUnderProgress<T>(
  viewId: string, instance: Pick<Instance, 'refresh'>, command: (progress: Progress, written: WrittenFiles) => Promise<T>,
): Promise<T> {
  const progress = pausableProgress(viewId);
  const handedBefore = readModel?.handed();
  progress.working();
  try {
    return await handingOneChange(instance, (written) => command(progress, written));
  } finally {
    progress.working();
    try {
      if (readModel !== undefined && readModel.handed() !== handedBefore) await readModel.taken();
    } finally {
      await progress.done();
    }
  }
}

/** A write that told the Instance loader of each file shows nothing more. */
export async function refreshWritten(instance: Pick<Instance, 'refresh'>, written: WrittenFiles): Promise<void> {
  if (written.named?.length !== 0) await instance.refresh(written.named);
}

interface ManagerSurface {
  readonly reporter: Reporter;
  /** Reads whether the mod manager is running at this moment. */
  readonly running: () => Promise<ManagerState>;
  /** What the state says, or undefined when it says nothing. */
  readonly message: (state: ManagerState) => string | undefined;
}

export type ManagerState = { readonly kind: 'running' | 'notRunning' } | { readonly kind: 'unknown'; readonly reason: string };

interface ManagerWarning {
  readonly kind: 'running' | 'unknown';
  readonly message: string;
}

let managerSurface: ManagerSurface | undefined;
let toldUnknown = false;
let toldFailure: string | undefined;

export function surfaceManagerRunning(on: ManagerSurface): { dispose: () => void } {
  managerSurface = on;
  toldUnknown = false;
  toldFailure = undefined;
  return { dispose: () => { managerSurface = undefined; } };
}

async function askedOfManager(): Promise<ManagerWarning | undefined> {
  try {
    if (managerSurface === undefined) return undefined;
    const state = await managerSurface.running();
    const message = managerSurface.message(state);
    return message === undefined ? undefined : { kind: state.kind === 'unknown' ? 'unknown' : 'running', message };
  } catch (e) {
    const why = errorMessage(e);
    if (why !== toldFailure) managerSurface?.reporter.shownOnSurface('warning', 'Cannot tell whether the mod manager is running', why);
    toldFailure = why;
    return { kind: 'unknown', message: `Cannot tell whether the mod manager is running: ${why}.` };
  }
}

function warningFor(answer: ManagerWarning | undefined): string | undefined {
  const newlyUnknown = answer?.kind === 'unknown' && !toldUnknown;
  toldUnknown = answer?.kind === 'unknown';
  return answer !== undefined && (answer.kind === 'running' || newlyUnknown) ? answer.message : undefined;
}

const wroteNothing = (result: unknown): boolean =>
  typeof result === 'object' && result !== null && 'applied' in result && result.applied === false;

let inFlight: string | undefined;

interface ReadModel {
  /** How many sends the other read model was handed. */
  readonly handed: () => number;
  /** Settles once the other read model has taken the newest send. */
  readonly taken: () => Promise<unknown>;
}

let readModel: ReadModel | undefined;

/** Sets the other read model, such as mEdit's record index, that a writing gesture waits on when its work led to a send. */
export function surfaceReadModel(on: ReadModel): { dispose: () => void } {
  readModel = on;
  return { dispose: () => { readModel = undefined; } };
}

interface RefusalSurface {
  readonly reporter: Reporter;
  /** The title of each gesture's Command ID, which a refusal names the write by. */
  readonly titles: ReadonlyMap<string, string>;
  /** Draws the views from the held value, so a control the user toggled does not keep a state nothing wrote. */
  readonly redraw: () => void;
}

let surface: RefusalSurface | undefined;

export function surfaceRefusedWrites(on: RefusalSurface): { dispose: () => void } {
  surface = on;
  return { dispose: () => { surface = undefined; } };
}

const titleOf = (command: string): string => surface?.titles.get(command) ?? command;

/** A write refused because another is in flight. */
export class RefusedWrite extends Refusal {}

/** Runs `work` as a view call: a refused write is told once in a notification and the Output, and the views are
 *  drawn from the held value. An agent's call skips this: the reason goes back to it. */
export async function asViewCall<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof RefusedWrite)) throw e;
    surface?.reporter.report('error', e.message);
    surface?.redraw();
    return undefined;
  }
}

/** Runs the `write` gesture's `work`. One write runs at a time (commands.md, Refuse, do not repair): a write asked
 *  while another is in flight is refused, naming it. */
export async function holdingTheWrite<T>(write: string, work: () => Promise<T>): Promise<T> {
  if (inFlight !== undefined) throw new RefusedWrite(`${titleOf(write)} did not start: ${titleOf(inFlight)} is still writing.`);
  inFlight = write;
  const asked = askedOfManager();
  let result: T;
  try {
    result = await work();
  } finally {
    inFlight = undefined;
  }
  const warning = warningFor(await asked);
  if (warning !== undefined && !wroteNothing(result)) managerSurface?.reporter.report('warning', warning);
  return result;
}

/** Runs the `write` gesture's `command` under the view's progress, holding the write. */
export const runWritingGesture = <T>(
  write: string, viewId: string, instance: Pick<Instance, 'refresh'>, command: (progress: Progress, written: WrittenFiles) => Promise<T>,
): Promise<T> => holdingTheWrite(write, () => runUnderProgress(viewId, instance, command));
