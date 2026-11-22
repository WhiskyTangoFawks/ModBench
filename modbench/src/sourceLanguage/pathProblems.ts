import type { MEditClient, PluginAddress, PluginFilePaths } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import { askingOnChange } from '../drivingLib/problemsAsker';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';
import { pluginAddressKey } from '../wire/pluginAddress';
import { addNamed, type PluginRecords } from '../drivingLib/namedPlugins';
import { askedAgain, positionAt, askingWhenNotLate, settling, type Asked, type Feed } from './feedShape';
import { tellingOnSurface, type Told } from '../drivingLib/tellingOnSurface';
import { joinedReasons, lastGoodReadMessage, pluginReason, quotedPluginName } from '../wire/reasons';
import type { ProblemOnFile, ProblemsByFile } from './sourceProblems';
import { stringsAt } from './sourceText';

// What a new value changed of what the instance says of files: the origins whose files changed, and each path, folded, they
// hold or held; or anything.
type StandingChanged = 'every' | { readonly origins: ReadonlySet<string>; readonly paths: ReadonlySet<string> };

/** What the instance says of a file the plugin source names. */
export interface PathStanding {
  /** False unless the game folder is found and in the workspace: no path is judged otherwise. */
  judged: () => boolean;
  /** Whether the game gets the file at the Data-folder path `dataPath`, or the plugin's mod holds it. */
  holds: (plugin: PluginAddress, dataPath: string) => boolean;
  /** Each path, folded, the game tries for `dataPath`: `holds` answers by these alone, with its plugin's mod. */
  triedPaths: (dataPath: string) => readonly string[];
  subscribe: (listener: (changed: StandingChanged) => void) => { dispose: () => unknown };
}

export interface PathProblemsDeps {
  client: Pick<MEditClient, 'recordIndexMayBeLate' | 'onDidChangeRecordIndexMayBeLate'>;
  ask: Pick<Asked, 'getPluginFilePaths' | 'onPluginChanged' | 'onAskedAgain'>;
  sourceFiles: SourceFilesOf;
  readText: (path: string) => Promise<string>;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
  paths: PathStanding;
  /** Replaces every path problem published before. */
  publish: (problems: ProblemsByFile) => void;
  languageStatus: (text: string | undefined) => void;
}

type NamedFilePath = PluginFilePaths['paths'][number];

// `texts`: each file read once for the answer, since a change to a file brings a new answer.
interface Held { answer: PluginFilePaths; texts: Map<string, Promise<string>> }

const WHOLE_SET = '';

async function problemsOf({ answer: { plugin, paths: named }, texts }: Held, { paths, sourceFiles, readText }: PathProblemsDeps): Promise<ProblemsByFile> {
  const byFile = new Map<string, ProblemOnFile[]>();
  const files = sourceFiles(plugin.origin);
  if (!paths.judged() || files === undefined) return byFile;
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
  return byFile;
}

const merged = (each: Iterable<ProblemsByFile>): ProblemsByFile => {
  const byFile = new Map<string, ProblemOnFile[]>();
  for (const problems of each) for (const [file, found] of problems) byFile.set(file, [...byFile.get(file) ?? [], ...found]);
  return byFile;
};

/** Publishes each path a plugin's source names that no file the game gets or its mod holds answers to. The links feed
 *  tells of a plugin with no source folder. */
export function feedPathProblems(deps: PathProblemsDeps): Feed {
  const { client, reporter, paths, publish, languageStatus } = deps;
  const held = new Map<string, Held>();
  const failures = new Map<string, string>();
  const tell = tellingOnSurface(reporter, 'warning');
  let shown = 0;

  const unchecked = () => [...held.values()].flatMap(({ answer }) => [
    ...answer.failure == null ? [] : [pluginReason(answer.plugin, answer.failure)],
    ...answer.unread.map((line) => pluginReason(answer.plugin, line)),
  ]);
  const showStatus = () => {
    const failed = [...failures.values()][0];
    if (failed) languageStatus(lastGoodReadMessage([failed]));
    else languageStatus(unchecked().length > 0 ? `Some paths are not checked: ${joinedReasons(unchecked())}` : undefined);
  };
  const tellStanding = () => {
    const standing: Told[] = [...held].flatMap(([key, { answer }]) => [
      ...answer.unread.map((line) => ({ key: `${key}\n${line}`, message: `The Problems panel does not check every path ${quotedPluginName(answer.plugin)} names.`, why: line })),
      ...answer.failure == null ? [] : [{ key: `${key}\nfailure`, message: `The Problems panel checks only some of the paths ${quotedPluginName(answer.plugin)} names.`, why: answer.failure }],
    ]);
    tell([...standing, ...[...failures].map(([target, why]) => ({ key: `failed ${target}`, message: 'The Problems panel shows the last paths mEdit answered.', why }))]);
  };
  const asks = settling();
  // Each plugin's problems as its answer was last judged; a change that reaches a plugin forgets its own alone.
  const judgedOf = new Map<string, { answer: PluginFilePaths; problems: ProblemsByFile }>();
  const tried = new WeakMap<PluginFilePaths, ReadonlySet<string>>();
  const triedBy = (answer: PluginFilePaths): ReadonlySet<string> => {
    let held = tried.get(answer);
    if (held === undefined) {
      held = new Set(answer.paths.flatMap(({ dataPath }) => paths.triedPaths(dataPath)));
      tried.set(answer, held);
    }
    return held;
  };
  const reaches = (changed: StandingChanged, answer: PluginFilePaths): boolean => changed === 'every'
    || changed.origins.has(answer.plugin.origin) || [...changed.paths].some((path) => triedBy(answer).has(path));
  // A judgement a later change reached is stale before it ends, so it is not kept.
  let changes = 0;
  const reachedAt = new Map<string, number>();
  const judge = () => asks.working(async () => {
    const mine = ++shown;
    const started = changes;
    await Promise.all([...held].map(async ([key, entry]) => {
      if (judgedOf.get(key)?.answer === entry.answer) return;
      const problems = await problemsOf(entry, deps);
      if ((reachedAt.get(key) ?? 0) <= started) judgedOf.set(key, { answer: entry.answer, problems });
    }));
    for (const key of judgedOf.keys()) if (!held.has(key)) judgedOf.delete(key);
    if (mine === shown) publish(merged([...judgedOf.values()].map(({ problems }) => problems)));
  });
  const forget = (changed: StandingChanged): void => {
    changes += 1;
    for (const [key, { answer }] of held) {
      if (!reaches(changed, answer)) continue;
      judgedOf.delete(key);
      reachedAt.set(key, changes);
    }
  };
  const take = (answers: readonly PluginFilePaths[], target: string) => {
    const answered = new Set(answers.map(({ plugin }) => pluginAddressKey(plugin)));
    let changed = answers.length !== answered.size;
    for (const key of held.keys()) if ((target === WHOLE_SET || key === target) && !answered.has(key)) { held.delete(key); changed = true; }
    for (const answer of answers) {
      const key = pluginAddressKey(answer.plugin);
      if (held.get(key)?.answer === answer) continue;
      held.set(key, { answer, texts: new Map() });
      changed = true;
    }
    for (const failed of failures.keys()) if (target === WHOLE_SET || failed === target) failures.delete(failed);
    tellStanding();
    showStatus();
    if (changed) void judge();
  };
  const ask = async (plugin?: PluginAddress, atSubscribe = false, keys?: readonly string[]) => {
    const target = plugin === undefined ? WHOLE_SET : pluginAddressKey(plugin);
    try {
      const answer = answerOf(await deps.ask.getPluginFilePaths(plugin, keys));
      take(answer, target);
    } catch (error) {
      if (atSubscribe) return;
      failures.set(target, errorMessage(error));
      tellStanding();
      showStatus();
    }
  };
  const asking = new Map<string, PluginRecords>();
  let wholeWanted = true;
  let atSubscribe = true;
  const askWanted = asks.asking(async () => {
    const whole = wholeWanted;
    const first = atSubscribe;
    const named = [...asking.values()];
    wholeWanted = false;
    atSubscribe = false;
    asking.clear();
    await Promise.all(whole ? [ask(undefined, first)] : named.map(({ plugin, keys }) => ask(plugin, false, keys)));
  });
  const askPlugin = (named: PluginRecords) => {
    addNamed(asking, named);
    askWanted();
  };
  const whenNotLate = askingWhenNotLate(client, askPlugin);
  const unsubscribe = [
    deps.ask.onPluginChanged(askingOnChange(() => { wholeWanted = true; askWanted(); }, whenNotLate.plugin)),
    deps.ask.onAskedAgain('getPluginFilePaths', askedAgain(() => { wholeWanted = true; askWanted(); }, whenNotLate.plugin)),
    whenNotLate.stop,
  ];
  const judging = paths.subscribe((changed) => {
    forget(changed);
    void judge();
  });
  askWanted();
  return { stop: () => { for (const off of unsubscribe) off(); judging.dispose(); }, settled: asks.settled };
}
