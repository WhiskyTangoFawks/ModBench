import type { TrackStatus } from './ApiClient';

/** #414 review F2: what the Plugins view says about itself while a Track is running — the text
 *  behind `TreeView.message` via `say()`, the same surface #307's `sessionProgressMessage` already
 *  narrates the session load through (`withPluginsViewProgress`/`say`, `extension.ts`). A mega-
 *  plugin's Track is a worst-case tens-of-seconds operation (AC4); this is what makes it honest
 *  rather than a static spinner over an unchanging message.
 *
 *  A pure function of the status, mirroring `sessionProgressMessage`, so it is unit-testable
 *  without a VS Code harness.
 *
 *  #451 review: `status.pluginsDone`/`pluginsTotal` count plugins, not records — Track's own #451
 *  slice A rewrite serializes each plugin through the whole-mod door in one call, with no per-record
 *  progress of its own to report, and the wire fields were renamed to say so (`TrackProgress.cs`).
 *  This function's own text follows that rename rather than mislabeling a plugin count as records. */
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
