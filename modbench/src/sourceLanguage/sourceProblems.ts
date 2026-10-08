import type { MEditClient, PluginProblems } from '../client';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';
import { problemSpan } from './sourceText';

type SourceProblem = PluginProblems['problems'][number];

interface Position { line: number; character: number }
export interface ProblemOnFile { message: string; start: Position; end: Position }
/** Every problem mEdit answered, by the absolute path of the file it sits on. */
export type ProblemsByFile = ReadonlyMap<string, ProblemOnFile[]>;

export interface SourceProblemsDeps {
  client: Pick<MEditClient, 'getPluginProblems' | 'onNotification' | 'onReconnected'>;
  originFiles: OriginFilesOf;
  readText: (path: string) => Promise<string>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  /** Replaces every problem published before. */
  publish: (problems: ProblemsByFile) => void;
  /** Says why the Problems panel shows the last good read; undefined when it shows the latest. */
  languageStatus: (text: string | undefined) => void;
}

const FIRST_LINE = { line: 0, character: 0 };

function positionAt(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function onText(text: string, problem: SourceProblem): ProblemOnFile {
  const target = problemSpan(text, problem);
  return target
    ? { message: problem.message, start: positionAt(text, target.start), end: positionAt(text, target.end) }
    : { message: problem.message, start: FIRST_LINE, end: FIRST_LINE };
}

interface Told { key: string; message: string; why: string }

function tellingOnce(say: (message: string, why: string) => void): (standing: Told[]) => void {
  let told = new Map<string, string>();
  return (standing) => {
    for (const { key, message, why } of standing) if (told.get(key) !== why) say(message, why);
    told = new Map(standing.map(({ key, why }) => [key, why]));
  };
}

type OnFiles = Map<string, ProblemOnFile[]>;
/** A plugin's problems by file: the links it holds to missing records, and the files whose read stopped. */
interface Contribution { links: OnFiles; stops: OnFiles }
interface Unplaced extends Told { plugin: string }
interface Placed { ofPlugin: Map<string, Contribution | undefined>; unplaced: Unplaced[]; unread: Told[] }

const nameOf = ({ name, origin }: { name: string; origin: string }) => `"${name}" (${origin})`;
const isLink = (problem: SourceProblem) => problem.fieldPath != null;

async function placed(answer: PluginProblems[], { originFiles, readText }: SourceProblemsDeps): Promise<Placed> {
  const unplaced: Unplaced[] = [];
  const unread: Told[] = [];
  const ofPlugin = new Map(await Promise.all(answer.map(async ({ plugin, problems, failure }) => {
    const files = originFiles(plugin.origin);
    const key = pluginAddressKey(plugin);
    const why = files === undefined ? `The instance holds no folder for ${plugin.origin}.` : failure;
    if (why != null) unplaced.push({ key, message: `The Problems panel keeps the last problems of ${nameOf(plugin)}.`, why, plugin: nameOf(plugin) });
    if (files === undefined) return [key, undefined] as const;
    const contribution: Contribution = { links: new Map(), stops: new Map() };
    const byPath = new Map<string, SourceProblem[]>();
    for (const problem of problems) {
      const path = files.file(problem.sourceRelativePath);
      byPath.set(path, [...(byPath.get(path) ?? []), problem]);
    }
    await Promise.all([...byPath].map(async ([path, onPath]) => {
      const text = await readText(path).catch((error: unknown) => {
        unread.push({ key: path, message: `The Problems panel shows the problems of "${path}" on its first line.`, why: errorMessage(error) });
        return '';
      });
      contribution.links.set(path, onPath.filter(isLink).map((problem) => onText(text, problem)));
      contribution.stops.set(path, onPath.filter((problem) => !isLink(problem)).map((problem) => onText(text, problem)));
    }));
    return [key, contribution] as const;
  })));
  return { ofPlugin, unplaced, unread };
}

function onEveryFile(contributions: Contribution[]): ProblemsByFile {
  const byFile: OnFiles = new Map();
  for (const { links, stops } of contributions) for (const onFiles of [stops, links]) {
    for (const [path, onFile] of onFiles) if (onFile.length > 0) byFile.set(path, [...byFile.get(path) ?? [], ...onFile]);
  }
  return byFile;
}

/** Publishes what mEdit answers is wrong in each tracked active plugin's source. A plugin mEdit
 *  cannot answer for keeps the links it last had and takes the stops it now answers, and the
 *  language status says why. */
export function feedSourceProblems(deps: SourceProblemsDeps): () => void {
  const { client, reporter, publish, languageStatus } = deps;
  const tellingOnSurface = () => tellingOnce((message, why) => { reporter.shownOnSurface('warning', message, why); });
  const tellUnplaced = tellingOnSurface();
  const tellUnread = tellingOnSurface();
  const lastRead = (why: string) => `Showing the last good read: ${why}`;
  let held = new Map<string, Contribution>();
  let unplacedStatus: string | undefined;
  let failed: { ask: number; why: string } | undefined;
  const showStatus = () => { languageStatus(failed ? lastRead(failed.why) : unplacedStatus); };
  // Unknown until a load-order-status says, or mEdit answers the ask made at subscribe.
  let ready: boolean | undefined;
  let latest = 0;
  let shown = 0;
  const ask = async (atSubscribe = false) => {
    const mine = ++latest;
    try {
      const { ofPlugin, unplaced, unread } = await placed(await client.getPluginProblems(), deps);
      if (atSubscribe) ready ??= true;
      if (mine < shown) return;
      shown = mine;
      if (failed && failed.ask < mine) failed = undefined;
      const unplacedKeys = new Set(unplaced.map(({ key }) => key));
      held = new Map([...ofPlugin].flatMap(([key, fresh]) => {
        const before = held.get(key);
        const now = unplacedKeys.has(key) && fresh ? { links: before?.links ?? new Map(), stops: fresh.stops } : fresh ?? before;
        return now ? [[key, now] as const] : [];
      }));
      publish(onEveryFile([...held.values()]));
      unplacedStatus = unplaced.length > 0 ? lastRead(unplaced.map(({ plugin, why }) => `${plugin}: ${why}`).join('; ')) : undefined;
      showStatus();
      tellUnplaced(unplaced);
      tellUnread(unread);
    } catch (error) {
      if (mine !== latest || atSubscribe) return;
      const why = errorMessage(error);
      if (why !== failed?.why) reporter.shownOnSurface('warning', 'The Problems panel shows mEdit\'s last answer.', why);
      failed = { ask: mine, why };
      showStatus();
    }
  };
  const reask = () => { void ask(); };
  const reaskWhenReady = () => { if (ready) reask(); };
  const unsubscribe = [
    client.onNotification('load-order-status', (status) => { ready = status.conflictsComputed; reaskWhenReady(); }),
    client.onNotification('rows-changed', reaskWhenReady),
    client.onNotification('plugin-changed', reaskWhenReady),
    client.onReconnected(reask),
  ];
  void ask(true);
  return () => { for (const off of unsubscribe) off(); };
}
