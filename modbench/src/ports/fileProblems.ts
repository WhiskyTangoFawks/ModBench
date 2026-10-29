import type { Log } from './log';

/** A problem on a file, shown in the Problems panel on `line` (1-based). */
interface FileProblem { readonly message: string; readonly line: number }

/** common.md, Reporting: a problem in the Problems panel on that file, and a line in the Output. */
export interface FileProblems {
  /** Replaces the problems on `file`; none clears them. */
  set: (file: string, problems: readonly FileProblem[]) => void;
  clearAll: () => void;
}

/** The Problems panel as the window gives it, `D` being its diagnostic. */
export interface ProblemsHost<D> {
  diagnostic: (problem: FileProblem) => D;
  publish: (file: string, diagnostics: readonly D[]) => void;
  clearAll: () => void;
}

export function fileProblemsOver<D>(host: ProblemsHost<D>, log: Log): FileProblems {
  return {
    set: (file, problems) => {
      for (const { line, message } of problems) log.warn(`${file}:${line}: ${message}`);
      host.publish(file, problems.map((problem) => host.diagnostic(problem)));
    },
    clearAll: () => { host.clearAll(); },
  };
}
