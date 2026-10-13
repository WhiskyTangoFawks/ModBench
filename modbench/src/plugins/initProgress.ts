import type { InitStatus } from '../client';

/** Pure, so it is testable without a VS Code harness. The counts are plugins, not records —
 *  init serializes a whole plugin in one call, with no per-record progress to report — and this
 *  text must not mislabel them. */
export function initProgressMessage(mod: string, status: InitStatus): string {
  switch (status.phase) {
    case 'Idle':
      return `Initializing "${mod}"…`;
    case 'Parsing':
      return status.pluginsTotal > 0
        ? `Initializing "${mod}" — parsing ${pluralizePlugin(status.pluginsTotal)}…`
        : `Initializing "${mod}" — parsing…`;
    case 'Serializing':
      return `Initializing "${mod}" — serialized ${status.pluginsDone} of ${pluralizePlugin(status.pluginsTotal)}…`;
    case 'ReadingFiles':
      return `Initializing "${mod}" — reading its files…`;
    case 'Committing':
      return `Initializing "${mod}" — committing to git…`;
  }
}

function pluralizePlugin(count: number): string {
  return count === 1 ? '1 plugin' : `${count} plugins`;
}
