import type { TrackStatus } from './ApiClient';

/** #414 review F2: what the Plugins view says about itself while a Track is running — the text
 *  behind `TreeView.message` via `say()`, the same surface #307's `sessionProgressMessage` already
 *  narrates the session load through (`withPluginsViewProgress`/`say`, `extension.ts`). A mega-
 *  plugin's Track is a worst-case tens-of-seconds operation (AC4); this is what makes it honest
 *  rather than a static spinner over an unchanging message.
 *
 *  A pure function of the status, mirroring `sessionProgressMessage`, so it is unit-testable
 *  without a VS Code harness. */
export function trackProgressMessage(origin: string, status: TrackStatus): string {
  switch (status.phase) {
    case 'Idle':
      return `Tracking "${origin}"…`;
    case 'Parsing':
      return status.recordsTotal > 0
        ? `Tracking "${origin}" — parsing ${status.recordsTotal} records…`
        : `Tracking "${origin}" — parsing…`;
    case 'Serializing':
      return `Tracking "${origin}" — serialized ${status.recordsDone} of ${status.recordsTotal} records…`;
    case 'Committing':
      return `Tracking "${origin}" — committing to git…`;
  }
}
