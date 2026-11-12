import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';
import { pluginAddressKey } from '../wire/pluginAddress';
import type { ProblemOnFile, ProblemsByFile } from './sourceProblems';
import { stringsAt } from './sourceText';

/** What the instance says of a file the plugin source names. */
export interface PathStanding {
  /** False while the game gets files from outside the workspace: no path is judged then. */
  judged: () => boolean;
  /** Whether the game gets the file at the Data-folder path `dataPath`, or the plugin's mod holds it. */
  holds: (plugin: PluginAddress, dataPath: string) => boolean;
  subscribe: (listener: () => void) => { dispose: () => unknown };
}

export interface PathProblemsDeps {
  client: Pick<MEditClient, 'getPluginFilePaths' | 'onNotification' | 'loadOrderStatus' | 'onLoadOrderSettled'>;
  sourceFiles: SourceFilesOf;
  readText: (path: string) => Promise<string>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  paths: PathStanding;
  /** Replaces every path problem published before. */
  publish: (problems: ProblemsByFile) => void;
  languageStatus: (text: string | undefined) => void;
}

type NamedFilePath = PluginFilePaths['paths'][number];

interface Held { answer: PluginFilePaths; ticket: number }

const nameOf = ({ name, origin }: PluginAddress) => `"${name}" (${origin})`;

function positionAt(text: string, offset: number): { line: number; character: number } {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

async function problemsOf(held: readonly PluginFilePaths[], { paths, sourceFiles, readText }: PathProblemsDeps): Promise<ProblemsByFile> {
  const byFile = new Map<string, ProblemOnFile[]>();
  if (!paths.judged()) return byFile;
  await Promise.all(held.map(async ({ plugin, paths: named }) => {
    const files = sourceFiles(plugin.origin);
    if (files === undefined) return;
    const missing = named.filter(({ dataPath }) => !paths.holds(plugin, dataPath));
    const filesOf = new Map<string, NamedFilePath[]>();
    for (const path of missing) {
      const file = files.file(path.sourceRelativePath);
      filesOf.set(file, [...filesOf.get(file) ?? [], path]);
    }
    await Promise.all([...filesOf].map(async ([file, naming]) => {
      const text = await readText(file).catch(() => '');
      const found = naming.map(({ formKey, fieldPath, dataPath }): ProblemOnFile => {
        const [span] = stringsAt(text, formKey, [fieldPath]);
        const at = span ?? { start: 0, end: 0 };
        return { message: `"${dataPath}" names no file the game gets or ${plugin.origin} holds.`, start: positionAt(text, at.start), end: positionAt(text, at.end) };
      });
      byFile.set(file, [...byFile.get(file) ?? [], ...found]);
    }));
  }));
  return byFile;
}

/** Publishes each path a compiled plugin's source names that no file the game gets or its mod holds answers to. mEdit
 *  names the paths; the instance says what holds them, so a change to the files judges again without asking (ADR-0003). */
export function feedPathProblems(deps: PathProblemsDeps): () => void {
  const { client, reporter, paths, publish, languageStatus } = deps;
  const held = new Map<string, Held>();
  const told = new Map<string, string>();
  let ticket = 0;
  let failed: string | undefined;
  let answeredAtSubscribe = false;

  const tell = (key: string, message: string, why: string) => {
    if (told.get(key) === why) return;
    told.set(key, why);
    reporter.shownOnSurface('warning', message, why);
  };
  const showStatus = () => {
    const unchecked = [...held.values()].flatMap(({ answer }) => [
      ...answer.failure == null ? [] : [`${nameOf(answer.plugin)}: ${answer.failure}`],
      ...answer.unread.map((line) => `${nameOf(answer.plugin)}: ${line}`),
    ]);
    if (failed !== undefined) languageStatus(`Showing the last good read of the paths: ${failed}`);
    else languageStatus(unchecked.length > 0 ? `Some paths are not checked: ${unchecked.join('; ')}` : undefined);
  };
  let shown = 0;
  const judge = async () => {
    const mine = ++shown;
    const problems = await problemsOf([...held.values()].map(({ answer }) => answer), deps);
    if (mine === shown) publish(problems);
  };
  const take = (answers: readonly PluginFilePaths[], mine: number, whole: boolean) => {
    for (const answer of answers) {
      const key = pluginAddressKey(answer.plugin);
      if ((held.get(key)?.ticket ?? 0) >= mine) continue;
      held.set(key, { answer, ticket: mine });
      for (const line of answer.unread) tell(`${key}\n${line}`, `The Problems panel does not check every path ${nameOf(answer.plugin)} names.`, line);
      if (answer.failure != null) tell(`${key}\nfailure`, `The Problems panel checks only some of the paths ${nameOf(answer.plugin)} names.`, answer.failure);
    }
    if (whole) {
      const answered = new Set(answers.map(({ plugin }) => pluginAddressKey(plugin)));
      for (const [key, { ticket: had }] of held) if (!answered.has(key) && had < mine) held.delete(key);
    }
    failed = undefined;
    showStatus();
    void judge();
  };
  const ask = async (plugin?: PluginAddress, atSubscribe = false) => {
    const mine = ++ticket;
    try {
      const answer = answerOf(await client.getPluginFilePaths(plugin));
      if (atSubscribe) answeredAtSubscribe = true;
      take(answer, mine, plugin === undefined);
    } catch (error) {
      if (atSubscribe) return;
      const why = errorMessage(error);
      tell('failed', 'The Problems panel shows the last paths mEdit answered.', why);
      failed = why;
      showStatus();
    }
  };
  const ready = () => client.loadOrderStatus?.conflictsComputed ?? answeredAtSubscribe;
  const askWhole = coalesced(() => { void ask(); });
  const askPluginWhenReady = ({ plugin }: { plugin: PluginAddress }) => { if (ready()) void ask(plugin); };
  const unsubscribe = [
    client.onLoadOrderSettled((status) => { if (status.conflictsComputed) askWhole(); }),
    client.onNotification('rows-changed', askPluginWhenReady),
    client.onNotification('plugin-changed', askPluginWhenReady),
  ];
  const judging = paths.subscribe(() => { void judge(); });
  void ask(undefined, true);
  return () => {
    for (const off of unsubscribe) off();
    judging.dispose();
  };
}
