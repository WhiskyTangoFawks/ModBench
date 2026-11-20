import type { MEditClient, PluginAddress } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { PluginRecords } from '../drivingLib/namedPlugins';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';
import { joinedReasons, pluginReason } from '../wire/reasons';
import { failureReason, isNotYetAnswerable, isReadFailed, ReadFailedError } from '../wire/readFailed';

export interface FilePathsAsked { getPluginFilePaths(plugin?: PluginAddress, keys?: readonly string[]): ReturnType<MEditClient['getPluginFilePaths']> }

interface ScriptsNamedDeps {
  paths: FilePathsAsked;
  sourceFiles: SourceFilesOf;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

type NamedInFile = { file: string; name: string };
type Answered = Extract<Awaited<ReturnType<MEditClient['getPluginFilePaths']>>, unknown[]>;

/** Each script every compiled plugin's source names, with its file; `only` asks of those plugins, and none of `[]`.
 *  Undefined while the record index cannot answer yet. A plugin whose answer failed keeps what it last held. */
export function scriptsNamed({ paths, sourceFiles, reporter }: ScriptsNamedDeps): (only?: readonly PluginRecords[]) => Promise<NamedInFile[] | undefined> {
  const held = new Map<string, NamedInFile[]>();
  const namedBy = new WeakMap<object, NamedInFile[]>();
  let listed: NamedInFile[] | undefined;
  let told = '';

  const tellUnread = (answers: Answered) => {
    const why = joinedReasons(answers.flatMap(({ plugin, failure, unread }) => [...failure == null ? [] : [failure], ...unread].map((line) => pluginReason(plugin, line))));
    if (why !== '' && why !== told) reporter.shownOnSurface('warning', 'The Problems panel does not check every script plugin source names.', why);
    told = why;
  };

  const take = (answers: Answered, only: readonly PluginRecords[] | undefined) => {
    for (const key of [...held.keys()]) {
      const asked = only === undefined || only.some(({ plugin }) => pluginAddressKey(plugin) === key);
      if (asked && !answers.some(({ plugin }) => pluginAddressKey(plugin) === key)) { held.delete(key); listed = undefined; }
    }
    for (const answer of answers) {
      const { plugin, scripts, failure } = answer;
      const files = sourceFiles(plugin.origin);
      if (failure != null) continue;
      const named = namedBy.get(answer) ?? (files === undefined ? [] : scripts.map(({ name, sourceRelativePath }) => ({ file: files.file(sourceRelativePath), name })));
      if (files !== undefined) namedBy.set(answer, named);
      if (held.get(pluginAddressKey(plugin)) !== named) listed = undefined;
      held.set(pluginAddressKey(plugin), named);
    }
  };

  return async (only) => {
    const asked = await Promise.all(only === undefined ? [paths.getPluginFilePaths()] : only.map(({ plugin, keys }) => paths.getPluginFilePaths(plugin, keys)));
    const failed = asked.find(isReadFailed);
    if (failed !== undefined) {
      if (isNotYetAnswerable(failed)) return undefined;
      throw new ReadFailedError(failureReason(failed));
    }
    const answers = asked.flatMap((answer) => (isReadFailed(answer) ? [] : answer));
    take(answers, only);
    tellUnread(answers);
    listed ??= [...held.values()].flat();
    return listed;
  };
}
