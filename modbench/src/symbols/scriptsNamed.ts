import type { MEditClient, PluginAddress } from '../client';
import type { SourceFilesOf } from '../instanceLoader/loadOrderSnapshot';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey, pluginRowName } from '../wire/pluginAddress';
import { failureReason, isNotYetAnswerable, isReadFailed, ReadFailedError } from '../wire/readFailed';

interface ScriptsNamedDeps {
  paths: Pick<MEditClient, 'getPluginFilePaths'>;
  sourceFiles: SourceFilesOf;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

type NamedInFile = { file: string; name: string };
type Answered = Extract<Awaited<ReturnType<MEditClient['getPluginFilePaths']>>, unknown[]>;

/** Each script every compiled plugin's source names, with its file; `only` asks of those plugins, and none of `[]`.
 *  Undefined while the record index cannot answer yet. A plugin whose answer failed keeps what it last held. */
export function scriptsNamed({ paths, sourceFiles, reporter }: ScriptsNamedDeps): (only?: readonly PluginAddress[]) => Promise<NamedInFile[] | undefined> {
  const held = new Map<string, NamedInFile[]>();
  let told = '';

  const tellUnread = (answers: Answered) => {
    const why = answers.flatMap(({ plugin, failure, unread }) => [...failure == null ? [] : [failure], ...unread].map((line) => `${pluginRowName(plugin)}: ${line}`)).join('; ');
    if (why !== '' && why !== told) reporter.shownOnSurface('warning', 'The Problems panel does not check every script plugin source names.', why);
    told = why;
  };

  const take = (answers: Answered, only: readonly PluginAddress[] | undefined) => {
    for (const key of [...held.keys()]) {
      const asked = only === undefined || only.some((plugin) => pluginAddressKey(plugin) === key);
      if (asked && !answers.some(({ plugin }) => pluginAddressKey(plugin) === key)) held.delete(key);
    }
    for (const { plugin, scripts, failure } of answers) {
      const files = sourceFiles(plugin.origin);
      if (failure == null) held.set(pluginAddressKey(plugin), files === undefined ? [] : scripts.map(({ name, sourceRelativePath }) => ({ file: files.file(sourceRelativePath), name })));
    }
  };

  return async (only) => {
    const asked = await Promise.all(only === undefined ? [paths.getPluginFilePaths()] : only.map((plugin) => paths.getPluginFilePaths(plugin)));
    const failed = asked.find(isReadFailed);
    if (failed !== undefined) {
      if (isNotYetAnswerable(failed)) return undefined;
      throw new ReadFailedError(failureReason(failed));
    }
    const answers = asked.flatMap((answer) => (isReadFailed(answer) ? [] : answer));
    take(answers, only);
    tellUnread(answers);
    return [...held.values()].flat();
  };
}
