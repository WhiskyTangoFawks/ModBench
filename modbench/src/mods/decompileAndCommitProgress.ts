import type { DecompileProgress } from '../sourceCommands/sourceCommands';

/** A progress with no phase is the gesture between steps. */
export function decompileAndCommitProgressMessage(mod: string, phase: DecompileProgress['phase']): string {
  const doing = `Decompiling and committing "${mod}"`;
  switch (phase) {
    case 'Parsing':
      return `${doing} — parsing…`;
    case 'Serializing':
      return `${doing} — serializing…`;
    case 'ReadingFiles':
      return `${doing} — reading its files…`;
    case 'Committing':
      return `${doing} — committing to git…`;
    case undefined:
    case null:
      return `${doing}…`;
  }
}
