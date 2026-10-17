import type { InitStatus } from '../client';

/** Pure, so it is testable without a VS Code harness. The counts are plugins, not records —
 *  decompile and commit serializes a whole plugin in one call, with no per-record progress to report — and this
 *  text must not mislabel them. */
export function decompileAndCommitProgressMessage(mod: string, status: InitStatus): string {
  switch (status.phase) {
    case 'Idle':
      return `Decompiling and committing "${mod}"…`;
    case 'Parsing':
      return status.pluginsTotal > 0
        ? `Decompiling and committing "${mod}" — parsing ${pluralizePlugin(status.pluginsTotal)}…`
        : `Decompiling and committing "${mod}" — parsing…`;
    case 'Serializing':
      return `Decompiling and committing "${mod}" — serialized ${status.pluginsDone} of ${pluralizePlugin(status.pluginsTotal)}…`;
    case 'ReadingFiles':
      return `Decompiling and committing "${mod}" — reading its files…`;
    case 'Committing':
      return `Decompiling and committing "${mod}" — committing to git…`;
  }
}

function pluralizePlugin(count: number): string {
  return count === 1 ? '1 plugin' : `${count} plugins`;
}
