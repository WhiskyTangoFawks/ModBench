import { COMMITTED, NO_FILE_CHANGES, type EntryOwner, type ScriptSymbol } from '../symbolNames/symbolNames';
import type { PluginAddress } from '../wire/pluginAddress';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { MEditClient } from './MEditClient';

interface ScriptSourceRenameDeps {
  readonly client: Pick<MEditClient, 'getScriptRenameSourceChanges'>;
  /** The native Source Control panel misses a working-tree change on its own. */
  readonly refreshSourceControlFor: (plugin: PluginAddress) => void;
}

/** Plugin source's part in renaming a Papyrus script, as mEdit answers it (ADR-0028). */
export function scriptSourceRename({ client, refreshSourceControlFor }: ScriptSourceRenameDeps): EntryOwner<ScriptSymbol> {
  return {
    async plan({ name }, newName) {
      const answer = await client.getScriptRenameSourceChanges(name, newName);
      if (isReadFailed(answer)) {
        return { changes: NO_FILE_CHANGES, cannotFollow: [`the plugins mEdit reads: ${failureReason(answer)}`], commit: () => Promise.resolve(COMMITTED) };
      }
      return {
        changes: { ...NO_FILE_CHANGES, documents: answer.documents },
        cannotFollow: answer.leftBehind,
        commit: () => {
          for (const plugin of answer.plugins) refreshSourceControlFor(plugin);
          return Promise.resolve(COMMITTED);
        },
      };
    },
  };
}
