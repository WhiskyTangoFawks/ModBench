import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { coalesced } from '../ports/coalesced';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';
import { pluginAddressKey } from '../wire/pluginAddress';
import { lastRead, positionAt, readiness, tellingOnSurface, type Told } from './feedShape';
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

const WHOLE_SET = '';
const nameOf = ({ name, origin }: PluginAddress) => `"${name}" (${origin})`;

async function problemsOf(held: readonly PluginFilePaths[], { paths, sourceFiles, readText }: PathProblemsDeps): Promise<ProblemsByFile> {
  const byFile = new Map<string, ProblemOnFile[]>();
  if (!paths.judged()) return byFile;
  await Promise.all(held.map(async ({ plugin, paths: named }) => {
    const files = sourceFiles(plugin.origin);
    if (files === undefined) return;
    const filesOf = new Map<string, NamedFilePath[]>();
    for (const path of named.filter(({ dataPath }) => !paths.holds(plugin, dataPath))) {
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

/** Publishes each path a plugin's source names that no file the game gets or its mod holds answers to. A change to the
 *  files judges again without asking mEdit (ADR-0003). A plugin with no source folder is told by the links feed. */
export function feedPathProblems(deps: PathProblemsDeps): () => void {
  const { client, reporter, paths, publish, languageStatus } = deps;
  const held = new Map<string, Held>();
  const failures = new Map<string, { ask: number; why: string }>();
  const latestOf = new Map<string, number>();
  const tell = tellingOnSurface(reporter);
  const { ready, answeredAtSubscribe } = readiness(client);
  let ticket = 0;
  let shown = 0;

  const unchecked = () => [...held.values()].flatMap(({ answer }) => [
    ...answer.failure == null ? [] : [`${nameOf(answer.plugin)}: ${answer.failure}`],
    ...answer.unread.map((line) => `${nameOf(answer.plugin)}: ${line}`),
  ]);
  const showStatus = () => {
    const failed = [...failures.values()][0];
    if (failed) languageStatus(lastRead(failed.why));
    else languageStatus(unchecked().length > 0 ? `Some paths are not checked: ${unchecked().join('; ')}` : undefined);
  };
  const tellStanding = () => {
    const standing: Told[] = [...held].flatMap(([key, { answer }]) => [
      ...answer.unread.map((line) => ({ key: `${key}\n${line}`, message: `The Problems panel does not check every path ${nameOf(answer.plugin)} names.`, why: line })),
      ...answer.failure == null ? [] : [{ key: `${key}\nfailure`, message: `The Problems panel checks only some of the paths ${nameOf(answer.plugin)} names.`, why: answer.failure }],
    ]);
    tell([...standing, ...[...failures].map(([target, { why }]) => ({ key: `failed ${target}`, message: 'The Problems panel shows the last paths mEdit answered.', why }))]);
  };
  const judge = async () => {
    const mine = ++shown;
    const problems = await problemsOf([...held.values()].map(({ answer }) => answer), deps);
    if (mine === shown) publish(problems);
  };
  const take = (answers: readonly PluginFilePaths[], target: string, mine: number) => {
    for (const answer of answers) {
      const key = pluginAddressKey(answer.plugin);
      if ((held.get(key)?.ticket ?? 0) < mine) held.set(key, { answer, ticket: mine });
    }
    if (target === WHOLE_SET) {
      const answered = new Set(answers.map(({ plugin }) => pluginAddressKey(plugin)));
      for (const [key, { ticket: had }] of held) if (!answered.has(key) && had < mine) held.delete(key);
    }
    for (const [failed, { ask }] of failures) if (target === WHOLE_SET || failed === target) if (ask < mine) failures.delete(failed);
    tellStanding();
    showStatus();
    void judge();
  };
  const ask = async (plugin?: PluginAddress, atSubscribe = false) => {
    const target = plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);
    const mine = ++ticket;
    latestOf.set(target, mine);
    try {
      const answer = answerOf(await client.getPluginFilePaths(plugin));
      if (atSubscribe) answeredAtSubscribe();
      take(answer, target, mine);
    } catch (error) {
      if (atSubscribe || latestOf.get(target) !== mine) return;
      failures.set(target, { ask: mine, why: errorMessage(error) });
      tellStanding();
      showStatus();
    }
  };
  const asking = new Map<string, PluginAddress>();
  const askAsked = coalesced(() => {
    for (const plugin of asking.values()) void ask(plugin);
    asking.clear();
  });
  const askWhole = coalesced(() => { void ask(); });
  const askPluginWhenReady = ({ plugin }: { plugin: PluginAddress }) => {
    if (!ready()) return;
    asking.set(pluginAddressKey(plugin), plugin);
    askAsked();
  };
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
