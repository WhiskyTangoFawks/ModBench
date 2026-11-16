import type { MEditClient, PluginAddress, PluginProblems } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { askingOnChange } from '../drivingLib/problemsAsker';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import type { PathHop } from '../wire/messages';
import { pluginAddressKey } from '../wire/pluginAddress';
import { locationOf, type Segment } from './sourceText';
import { askedAgain, lastRead, readiness, settling, tellingOnSurface, type Asked, type Feed, type Position, type Told } from './feedShape';
import { answerOf, failureReason, type ReadFailed } from '../wire/readFailed';

type SourceProblem = PluginProblems['problems'][number];

interface ClearingGesture { label: string; command: string; args: unknown[] }
export interface ProblemOnFile { message: string; start: Position; end: Position; clearing?: ClearingGesture }
/** Every problem mEdit answered, by the absolute path of the file it sits on. */
export type ProblemsByFile = ReadonlyMap<string, ProblemOnFile[]>;

export interface SourceProblemsDeps {
  client: Pick<MEditClient, 'loadOrderStatus' | 'onUnsavedHandOver'>;
  ask: Pick<Asked, 'getPluginProblems' | 'onPluginChanged' | 'onAskedAgain'>;
  sourceFiles: SourceFilesOf;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** Replaces every problem published before. */
  publish: (problems: ProblemsByFile) => void;
  /** Says why the Problems panel shows the last good read; undefined when it shows the latest. */
  languageStatus: (text: string | undefined) => void;
  /** Says why mEdit could not take the unsaved plugin source; undefined when it could. */
  unsavedStatus: (text: string | undefined) => void;
}

const unsavedBecause = (why: string): string => `mEdit could not take the unsaved plugin source: ${why}`;

const FIRST_LINE = { line: 0, character: 0 };

const hopOf = (segment: Segment): PathHop => typeof segment === 'number' ? { kind: 'index', index: segment } : { kind: 'member', name: segment };

// A list element is removed, since mEdit refuses a null element; any other field is set to null.
function clearingGesture({ plugin, problem }: { plugin: PluginAddress; problem: SourceProblem }): ClearingGesture | undefined {
  if (!problem.formKey || !problem.fieldPath || problem.uncheckedBecause) return undefined;
  const path = locationOf(problem.fieldPath).map(hopOf);
  const record = { formKey: problem.formKey, plugin: plugin.name, origin: plugin.origin };
  return path.at(-1)?.kind === 'index'
    ? { label: 'remove element', command: 'modbench.record.removeElement', args: [{ ...record, path }] }
    : { label: 'clear reference', command: 'modbench.record.editField', args: [record, { op: 'set', path, value: null }] };
}

function onFile(plugin: PluginAddress, problem: SourceProblem): ProblemOnFile {
  const clearing = clearingGesture({ plugin, problem });
  const { start, end } = problem.range ?? { start: FIRST_LINE, end: FIRST_LINE };
  return { message: problem.message, start, end, ...clearing && { clearing } };
}

type OnFiles = Map<string, ProblemOnFile[]>;
// A plugin's problems by file: the links it holds to missing records, and the files whose read stopped.
interface Contribution { links: OnFiles; stops: OnFiles }
// `told`: a failure mEdit does not log itself. It logs a later-read failure when it begins.
interface Unplaced extends Told { plugin: string; told: boolean }
interface Placed { ofPlugin: Map<string, Contribution | undefined>; unplaced: Unplaced[] }

const nameOf = ({ name, origin }: { name: string; origin: string }) => `"${name}" (${origin})`;
const isLink = (problem: SourceProblem) => problem.fieldPath != null;

function placed(answer: PluginProblems[], { sourceFiles }: SourceProblemsDeps): Placed {
  const unplaced: Unplaced[] = [];
  const ofPlugin = new Map(answer.map(({ plugin, problems, failure, failureKind }) => {
    const files = sourceFiles(plugin.origin);
    const key = pluginAddressKey(plugin);
    const why = files === undefined ? `The instance holds no source folder for ${plugin.origin}.` : failure;
    if (why != null) unplaced.push({ key, message: `The Problems panel keeps the last problems of ${nameOf(plugin)}.`, why, plugin: nameOf(plugin), told: files === undefined || failureKind !== 'LaterRead' });
    if (files === undefined) return [key, undefined] as const;
    const contribution: Contribution = { links: new Map(), stops: new Map() };
    const byPath = new Map<string, SourceProblem[]>();
    for (const problem of problems) {
      const path = files.file(problem.sourceRelativePath);
      byPath.set(path, [...(byPath.get(path) ?? []), problem]);
    }
    for (const [path, onPath] of byPath) {
      contribution.links.set(path, onPath.filter(isLink).map((problem) => onFile(plugin, problem)));
      contribution.stops.set(path, onPath.filter((problem) => !isLink(problem)).map((problem) => onFile(plugin, problem)));
    }
    return [key, contribution] as const;
  }));
  return { ofPlugin, unplaced };
}

function onEveryFile(contributions: Contribution[]): ProblemsByFile {
  const byFile: OnFiles = new Map();
  for (const { links, stops } of contributions) for (const onFiles of [stops, links]) {
    for (const [path, onFile] of onFiles) if (onFile.length > 0) byFile.set(path, [...byFile.get(path) ?? [], ...onFile]);
  }
  return byFile;
}

const WHOLE_SET = '';
const outsideTarget = <V>(held: ReadonlyMap<string, V>, target: string): [string, V][] =>
  target === WHOLE_SET ? [] : [...held].filter(([key]) => key !== target);

function nextHeld(held: Map<string, Contribution>, answered: Map<string, Contribution | undefined>, unplaced: Set<string>): Map<string, Contribution> {
  return new Map([...answered].flatMap(([key, fresh]) => {
    const before = held.get(key);
    const now = unplaced.has(key) && fresh ? { links: before?.links ?? new Map(), stops: fresh.stops } : fresh ?? before;
    return now ? [[key, now] as const] : [];
  }));
}

/** Publishes what mEdit answers is wrong in each compiled plugin's source. A plugin mEdit
 *  cannot answer for keeps the links it last had and takes the stops it now answers, and the
 *  language status says why. */
export function feedSourceProblems(deps: SourceProblemsDeps): Feed {
  const { client, reporter, publish, languageStatus, unsavedStatus } = deps;
  const tellUnplaced = tellingOnSurface(reporter);
  let held = new Map<string, Contribution>();
  let unplacedHeld = new Map<string, Unplaced>();
  const failures = new Map<string, string>();
  let handOverFailed: string | undefined;
  const showStatus = () => {
    const failed = [...failures.values()][0];
    if (failed !== undefined) languageStatus(lastRead(failed));
    else if (handOverFailed !== undefined) languageStatus(lastRead(unsavedBecause(handOverFailed)));
    else languageStatus(unplacedStatus());
  };
  const handedOver = (failure: ReadFailed | undefined) => {
    const why = failure && failureReason(failure);
    if (why !== undefined && why !== handOverFailed) {
      reporter.shownOnSurface('warning', 'The Problems panel shows what mEdit last took of the unsaved plugin source.', why);
    }
    handOverFailed = why;
    unsavedStatus(why === undefined ? undefined : lastRead(unsavedBecause(why)));
    showStatus();
  };
  const { ready, answeredAtSubscribe } = readiness(client);
  const unplacedStatus = () => unplacedHeld.size > 0
    ? lastRead([...unplacedHeld.values()].map(({ plugin, why }) => `${plugin}: ${why}`).join('; '))
    : undefined;
  const settle = (target: string, { ofPlugin, unplaced }: Placed) => {
    for (const failed of failures.keys()) if (target === WHOLE_SET || failed === target) failures.delete(failed);
    held = new Map([...outsideTarget(held, target), ...nextHeld(held, ofPlugin, new Set(unplaced.map(({ key }) => key)))]);
    unplacedHeld = new Map([...outsideTarget(unplacedHeld, target), ...unplaced.map((one) => [one.key, one] as const)]);
    publish(onEveryFile([...held.values()]));
    showStatus();
    tellUnplaced([...unplacedHeld.values()].filter(({ told }) => told));
  };
  const keepLastAnswer = (target: string, error: unknown) => {
    const why = errorMessage(error);
    if (why !== failures.get(target)) reporter.shownOnSurface('warning', 'The Problems panel shows mEdit\'s last answer.', why);
    failures.set(target, why);
    showStatus();
  };
  const ask = async (plugin?: PluginAddress, first = false) => {
    const target = plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);
    try {
      const answer = placed(answerOf(await deps.ask.getPluginProblems(plugin)), deps);
      if (first) answeredAtSubscribe();
      settle(target, answer);
    } catch (error) {
      if (!first) keepLastAnswer(target, error);
    }
  };
  let wholeWanted = true;
  let atSubscribe = true;
  const asking = new Map<string, PluginAddress>();
  const asks = settling();
  const askWanted = asks.asking(async () => {
    const [whole, first, named] = [wholeWanted, atSubscribe, [...asking.values()]];
    [wholeWanted, atSubscribe] = [false, false];
    asking.clear();
    await Promise.all(whole ? [ask(undefined, first)] : named.map((plugin) => ask(plugin)));
  });
  const askPluginWhenReady = ({ plugin }: { plugin: PluginAddress }) => {
    if (!ready()) return;
    asking.set(pluginAddressKey(plugin), plugin);
    askWanted();
  };
  const unsubscribe = [
    deps.ask.onPluginChanged(askingOnChange(() => { wholeWanted = true; askWanted(); }, askPluginWhenReady)),
    deps.ask.onAskedAgain('getPluginProblems', askedAgain(() => { wholeWanted = true; askWanted(); }, askPluginWhenReady)),
    client.onUnsavedHandOver(handedOver),
  ];
  askWanted();
  return { stop: () => { for (const off of unsubscribe) off(); }, settled: asks.settled };
}
