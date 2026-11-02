import type { InitProgress } from '../sourceCommands/sourceCommands';

/** A progress with no phase is the gesture between steps. */
export function versionInGitProgressMessage(mod: string, phase: InitProgress['phase']): string {
  const doing = `Version in git "${mod}"`;
  switch (phase) {
    case 'Parsing':
      return `${doing} — parsing…`;
    case 'Serializing':
      return `${doing} — serializing…`;
    case 'ReadingFiles':
      return `${doing} — reading its files…`;
    case 'Committing':
      return `${doing} — writing the repository…`;
    case undefined:
    case null:
      return `${doing}…`;
  }
}
