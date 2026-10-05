import type { TrackStatus } from '../client';

/** Pure, so it is testable without a VS Code harness. The counts are plugins, not records —
 *  Track serializes a whole plugin in one call, with no per-record progress to report — and this
 *  text must not mislabel them. */
export function trackProgressMessage(mod: string, status: TrackStatus): string {
  switch (status.phase) {
    case 'Idle':
      return `Tracking "${mod}"…`;
    case 'Parsing':
      return status.pluginsTotal > 0
        ? `Tracking "${mod}" — parsing ${pluralizePlugin(status.pluginsTotal)}…`
        : `Tracking "${mod}" — parsing…`;
    case 'Serializing':
      return `Tracking "${mod}" — serialized ${status.pluginsDone} of ${pluralizePlugin(status.pluginsTotal)}…`;
    case 'Committing':
      return `Tracking "${mod}" — committing to git…`;
  }
}

function pluralizePlugin(count: number): string {
  return count === 1 ? '1 plugin' : `${count} plugins`;
}
