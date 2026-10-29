/** A problem on a file, shown in the Problems panel: on `line` (1-based), else on the file. */
export interface FileProblem { readonly message: string; readonly line?: number }

export interface FileProblems {
  /** Replaces the problems on `file`; none clears them. */
  set: (file: string, problems: readonly FileProblem[]) => void;
  clearAll: () => void;
}
