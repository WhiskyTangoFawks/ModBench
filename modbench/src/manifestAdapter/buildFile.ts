// spec/formats/build-file.md, version 1: the build file as its schema states it.

export interface ManifestStep {
  readonly task: string;
  readonly args: readonly string[];
  readonly page?: string;
}

export interface ManifestArchive {
  readonly path: string;
  readonly files: readonly string[];
}

export interface BuildFile {
  readonly steps: readonly ManifestStep[];
  readonly archives: readonly ManifestArchive[];
}

export const BUILD_FILE_VERSION = 1;

export type BuildFileRead = { readonly buildFile: BuildFile } | { readonly refused: string };
