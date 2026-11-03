// spec/formats/build-file.md, version 1: the build file as its schema states it.

/** A step the VS Code user task its label names runs (source.md, Build, story 13). */
export interface TaskStep {
  readonly kind: 'task';
  readonly task: string;
  readonly args: readonly string[];
  readonly page?: string;
}

/** A step the Modbench script at `script`, a path in the source folder, runs (source.md, Build, story 16). */
export interface ScriptStep {
  readonly kind: 'script';
  readonly script: string;
  readonly args: readonly string[];
}

/** A step the default Modbench script `name` runs (scripts.md, Default scripts). */
export interface DefaultScriptStep {
  readonly kind: 'defaultScript';
  readonly name: string;
  readonly args: readonly string[];
}

export interface ManifestArchive {
  readonly path: string;
  readonly files: readonly string[];
}

/** A step that runs outside mEdit: a user task, or a Modbench script. */
export type RunStep = TaskStep | ScriptStep | DefaultScriptStep;

/** A built-in step names paths: a copy's in the source folder, and a decompile's or a compile's of plugins at the root. */
export type BuildStep =
  | { readonly kind: 'decompile' | 'compile' | 'copy'; readonly paths: readonly string[] }
  | { readonly kind: 'pack' | 'unpack'; readonly archives: readonly ManifestArchive[] }
  | RunStep;

export interface BuildFile {
  readonly steps: readonly BuildStep[];
}

export const BUILD_FILE_VERSION = 1;

/** A path a step reads from the source folder that names nothing there: of a compile step, a plugin with no plugin source. */
export interface BuildFileLack {
  readonly step: 'decompile' | 'compile' | 'copy' | 'unpack' | 'script';
  readonly path: string;
}

/** The build file a source folder holds, by its path, against that folder. */
export interface BuildFileAgainst {
  readonly file: string;
  readonly lacks: readonly BuildFileLack[];
}

export type BuildFileRead = { readonly buildFile: BuildFile } | { readonly refused: string };

const lineOf = (step: BuildStep): Record<string, unknown> => {
  switch (step.kind) {
    case 'pack': case 'unpack': return { [step.kind]: Object.fromEntries(step.archives.map(({ path, files }) => [path, files])) };
    case 'task': return { task: step.task, ...step.args.length === 0 ? {} : { args: step.args }, ...step.page === undefined ? {} : { page: step.page } };
    case 'script': return { script: step.script, ...step.args.length === 0 ? {} : { args: step.args } };
    case 'defaultScript': return { defaultScript: step.name, ...step.args.length === 0 ? {} : { args: step.args } };
    case 'decompile': case 'compile': case 'copy': return { [step.kind]: step.paths };
  }
};

/** The text of `buildFile`, a step to a line. */
export const buildFileText = ({ steps }: BuildFile): string =>
  steps.length === 0
    ? `{"version":${BUILD_FILE_VERSION}}\n`
    : `{"version":${BUILD_FILE_VERSION},"steps":[\n${steps.map((step) => JSON.stringify(lineOf(step))).join(',\n')}\n]}\n`;
