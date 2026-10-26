/** VS Code's tasks, by label. The tasks belong to the host, so the composition root implements them and every command
 *  that runs a step is handed them (mods.md, Build, story 14). */
export interface Tasks {
  /** The label of each task this machine has. */
  labels: () => Promise<readonly string[]>;
  /** Runs the task labelled `label` in `folder`, with `args` after its own, and answers its exit code, or why it ended
   *  with none. */
  run: (label: string, args: readonly string[], folder: string) => Promise<number | string>;
}
