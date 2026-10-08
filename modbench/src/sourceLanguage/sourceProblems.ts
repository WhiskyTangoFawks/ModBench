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
  /** Says why the Problems panel shows the last good read, and undefined once it no longer does. */
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
interface Unplaced extends Told { plugin: string }
interface Placed { ofPlugin: Map<string, OnFiles>; unplaced: Unplaced[]; unread: Told[] }

async function placed(answer: PluginProblems[], { originFiles, readText }: SourceProblemsDeps): Promise<Placed> {
  const unplaced: Unplaced[] = [];
  const unread: Told[] = [];
  const cannotShow = (name: string) => `The Problems panel cannot show "${name}"'s problems.`;
  const ofPlugin = new Map(await Promise.all(answer.map(async ({ plugin, problems, failure }) => {
    const files = originFiles(plugin.origin);
    const key = pluginAddressKey(plugin);
    const why = files === undefined ? `The instance holds no folder for ${plugin.origin}.` : failure;
    if (why != null) unplaced.push({ key, message: cannotShow(plugin.name), why, plugin: plugin.name });
    const onFiles: OnFiles = new Map();
    if (files === undefined) return [key, onFiles] as const;
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
      onFiles.set(path, onPath.map((problem) => onText(text, problem)));
    }));
    return [key, onFiles] as const;
  })));
  return { ofPlugin, unplaced, unread };
}

/** Publishes what mEdit answers is wrong in each tracked active plugin's source whenever a save,
 *  a re-read plugin or a new active set can change it. A plugin mEdit cannot answer for keeps the
 *  problems it last had, and the language status says why (plugin-source.md, In the text editor, story 6). */
export function feedSourceProblems(deps: SourceProblemsDeps): () => void {
  const { client, reporter, publish, languageStatus } = deps;
  const tellUnplaced = tellingOnce((message, why) => { reporter.shownOnSurface('warning', message, why); });
  const tellUnread = tellingOnce((message, why) => { reporter.shownOnSurface('warning', message, why); });
  const lastRead = (why: string) => `Showing the last good read: ${why}`;
  let held = new Map<string, OnFiles>();
  let unanswered: string | undefined;
  const keepLastAnswer = (error: unknown) => {
    const why = errorMessage(error);
    if (why !== unanswered) reporter.shownOnSurface('warning', 'The Problems panel shows mEdit\'s last answer.', why);
    unanswered = why;
    languageStatus(lastRead(why));
  };
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
      unanswered = undefined;
      const kept = new Set(unplaced.map(({ key }) => key));
      held = new Map([...ofPlugin].map(([key, onFiles]) => [key, kept.has(key) ? new Map([...held.get(key) ?? [], ...onFiles]) : onFiles]));
      publish(new Map([...held.values()].flatMap((onFiles) => [...onFiles])));
      languageStatus(unplaced.length > 0 ? lastRead(unplaced.map(({ plugin, why }) => `"${plugin}": ${why}`).join(' ')) : undefined);
      tellUnplaced(unplaced);
      tellUnread(unread);
    } catch (error) {
      if (mine === latest && !atSubscribe) keepLastAnswer(error);
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
