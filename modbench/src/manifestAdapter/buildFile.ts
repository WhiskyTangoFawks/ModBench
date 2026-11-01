// spec/formats/build-file.md, version 1: the build file as its schema states it.

/** A step the VS Code user task its label names runs (mods.md, Build, story 13). */
export interface TaskStep {
  readonly kind: 'task';
  readonly task: string;
  readonly args: readonly string[];
  readonly page?: string;
}

export interface ManifestArchive {
  readonly path: string;
  readonly files: readonly string[];
}

/** A built-in step names paths: a decompile and a copy in the source folder, a compile of plugins at the root of both. */
export type BuildStep =
  | { readonly kind: 'decompile' | 'compile' | 'copy'; readonly paths: readonly string[] }
  | { readonly kind: 'pack'; readonly archives: readonly ManifestArchive[] }
  | TaskStep;

export interface BuildFile {
  readonly steps: readonly BuildStep[];
}

export const BUILD_FILE_VERSION = 1;

export type BuildFileRead = { readonly buildFile: BuildFile } | { readonly refused: string };

const lineOf = (step: BuildStep): Record<string, unknown> => {
  switch (step.kind) {
    case 'pack': return { pack: Object.fromEntries(step.archives.map(({ path, files }) => [path, files])) };
    case 'task': return { task: step.task, ...step.args.length === 0 ? {} : { args: step.args }, ...step.page === undefined ? {} : { page: step.page } };
    case 'decompile': case 'compile': case 'copy': return { [step.kind]: step.paths };
  }
};

/** The text of `buildFile`, a step to a line. */
export const buildFileText = ({ steps }: BuildFile): string =>
  steps.length === 0
    ? `{"version":${BUILD_FILE_VERSION}}\n`
    : `{"version":${BUILD_FILE_VERSION},"steps":[\n${steps.map((step) => JSON.stringify(lineOf(step))).join(',\n')}\n]}\n`;
