import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { askingOnChange } from '../drivingLib/problemsAsker';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';
import { pluginAddressKey } from '../wire/pluginAddress';
import { askedAgain, lastRead, positionAt, readiness, settling, tellingOnSurface, type Asked, type Feed, type Told } from './feedShape';
import type { ProblemOnFile, ProblemsByFile } from './sourceProblems';
import { stringsAt } from './sourceText';

/** What the instance says of a file the plugin source names. */
export interface PathStanding {
  /** False unless the game folder is found and in the workspace: no path is judged otherwise. */
  judged: () => boolean;
  /** Whether the game gets the file at the Data-folder path `dataPath`, or the plugin's mod holds it. */
  holds: (plugin: PluginAddress, dataPath: string) => boolean;
  subscribe: (listener: () => void) => { dispose: () => unknown };
}

export interface PathProblemsDeps {
  client: Pick<MEditClient, 'loadOrderStatus'>;
  ask: Pick<Asked, 'getPluginFilePaths' | 'onPluginChanged' | 'onAskedAgain'>;
  sourceFiles: SourceFilesOf;
  readText: (path: string) => Promise<string>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
  paths: PathStanding;
  /** Replaces every path problem published before. */
  publish: (problems: ProblemsByFile) => void;
  languageStatus: (text: string | undefined) => void;
}

type NamedFilePath = PluginFilePaths['paths'][number];

// `texts`: each file read once for the answer, since a change to a file brings a new answer.
interface Held { answer: PluginFilePaths; texts: Map<string, Promise<string>> }

const WHOLE_SET = '';
const nameOf = ({ name, origin }: PluginAddress) => `"${name}" (${origin})`;

async function problemsOf(held: readonly Held[], { paths, sourceFiles, readText }: PathProblemsDeps): Promise<ProblemsByFile> {
  const byFile = new Map<string, ProblemOnFile[]>();
  if (!paths.judged()) return byFile;
  await Promise.all(held.map(async ({ answer: { plugin, paths: named }, texts }) => {
    const files = sourceFiles(plugin.origin);
    if (files === undefined) return;
    const filesOf = new Map<string, NamedFilePath[]>();
    for (const path of named.filter(({ dataPath }) => !paths.holds(plugin, dataPath))) {
      const file = files.file(path.sourceRelativePath);
      filesOf.set(file, [...filesOf.get(file) ?? [], path]);
    }
    await Promise.all([...filesOf].map(async ([file, naming]) => {
      if (!texts.has(file)) texts.set(file, readText(file).catch(() => ''));
      const text = await texts.get(file) ?? '';
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

/** Publishes each path a plugin's source names that no file the game gets or its mod holds answers to. The links feed
 *  tells of a plugin with no source folder. */
export function feedPathProblems(deps: PathProblemsDeps): Feed {
  const { client, reporter, paths, publish, languageStatus } = deps;
  const held = new Map<string, Held>();
  const failures = new Map<string, string>();
  const tell = tellingOnSurface(reporter);
  const { ready, answeredAtSubscribe } = readiness(client);
  let shown = 0;

  const unchecked = () => [...held.values()].flatMap(({ answer }) => [
    ...answer.failure == null ? [] : [`${nameOf(answer.plugin)}: ${answer.failure}`],
    ...answer.unread.map((line) => `${nameOf(answer.plugin)}: ${line}`),
  ]);
  const showStatus = () => {
    const failed = [...failures.values()][0];
    if (failed) languageStatus(lastRead(failed));
    else languageStatus(unchecked().length > 0 ? `Some paths are not checked: ${unchecked().join('; ')}` : undefined);
  };
  const tellStanding = () => {
    const standing: Told[] = [...held].flatMap(([key, { answer }]) => [
      ...answer.unread.map((line) => ({ key: `${key}\n${line}`, message: `The Problems panel does not check every path ${nameOf(answer.plugin)} names.`, why: line })),
      ...answer.failure == null ? [] : [{ key: `${key}\nfailure`, message: `The Problems panel checks only some of the paths ${nameOf(answer.plugin)} names.`, why: answer.failure }],
    ]);
    tell([...standing, ...[...failures].map(([target, why]) => ({ key: `failed ${target}`, message: 'The Problems panel shows the last paths mEdit answered.', why }))]);
  };
  const asks = settling();
  const judge = () => asks.working(async () => {
    const mine = ++shown;
    const problems = await problemsOf([...held.values()], deps);
    if (mine === shown) publish(problems);
  });
  const take = (answers: readonly PluginFilePaths[], target: string) => {
    const answered = new Set(answers.map(({ plugin }) => pluginAddressKey(plugin)));
    for (const key of held.keys()) if ((target === WHOLE_SET || key === target) && !answered.has(key)) held.delete(key);
    for (const answer of answers) held.set(pluginAddressKey(answer.plugin), { answer, texts: new Map() });
    for (const failed of failures.keys()) if (target === WHOLE_SET || failed === target) failures.delete(failed);
    tellStanding();
    showStatus();
    void judge();
  };
  const ask = async (plugin?: PluginAddress, atSubscribe = false) => {
    const target = plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);
    try {
      const answer = answerOf(await deps.ask.getPluginFilePaths(plugin));
      if (atSubscribe) answeredAtSubscribe();
      take(answer, target);
    } catch (error) {
      if (atSubscribe) return;
      failures.set(target, errorMessage(error));
      tellStanding();
      showStatus();
    }
  };
  const asking = new Map<string, PluginAddress>();
  let wholeWanted = true;
  let atSubscribe = true;
  const askWanted = asks.asking(async () => {
    const whole = wholeWanted;
    const first = atSubscribe;
    const named = [...asking.values()];
    wholeWanted = false;
    atSubscribe = false;
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
    deps.ask.onAskedAgain('getPluginFilePaths', askedAgain(() => { wholeWanted = true; askWanted(); }, askPluginWhenReady)),
  ];
  const judging = paths.subscribe(() => { void judge(); });
  askWanted();
  return { stop: () => { for (const off of unsubscribe) off(); judging.dispose(); }, settled: asks.settled };
}
