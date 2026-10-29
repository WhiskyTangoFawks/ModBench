import type { FileProblems } from '../ports/fileProblems';

type FileProblem = Parameters<FileProblems['set']>[1][number];

/** The Problems panel as a test reads it: the problems each file holds, a file with none holding nothing. */
export function fileProblemsFake(): FileProblems & { readonly held: Map<string, readonly FileProblem[]> } {
  const held = new Map<string, readonly FileProblem[]>();
  return {
    held,
    set: (file, problems) => {
      if (problems.length === 0) held.delete(file);
      else held.set(file, problems);
    },
    clearAll: () => { held.clear(); },
  };
}
