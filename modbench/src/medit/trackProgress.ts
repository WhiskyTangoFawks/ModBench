import type { TrackStatus } from './ApiClient';

/** Pure, so it is testable without a VS Code harness. The counts are plugins, not records —
 *  Track serializes a whole plugin in one call, with no per-record progress to report — and this
 *  text must not mislabel them. */
export function trackProgressMessage(origin: string, status: TrackStatus): string {
  switch (status.phase) {
    case 'Idle':
      return `Tracking "${origin}"…`;
    case 'Parsing':
      return status.pluginsTotal > 0
        ? `Tracking "${origin}" — parsing ${pluralizePlugin(status.pluginsTotal)}…`
        : `Tracking "${origin}" — parsing…`;
    case 'Serializing':
      return `Tracking "${origin}" — serialized ${status.pluginsDone} of ${pluralizePlugin(status.pluginsTotal)}…`;
    case 'Committing':
      return `Tracking "${origin}" — committing to git…`;
  }
}

function pluralizePlugin(count: number): string {
  return count === 1 ? '1 plugin' : `${count} plugins`;
}
