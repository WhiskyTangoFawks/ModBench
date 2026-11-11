import { dirname, normalize, sep } from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';
import { Refusal } from '../drivingLib/refusal';
import { fitting } from './tooLarge';

const keyOf = (path: string): string => {
  const normal = normalize(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normal.toLowerCase() : normal;
};

const isAt = (key: string, folder: string): boolean => key === folder || key.startsWith(folder + sep);

async function refuseMissing(paths: readonly string[]): Promise<void> {
  const missing = (await Promise.all(paths.map((path) => Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(path))).then(() => undefined, () => path))))
    .filter((path) => path !== undefined);
  if (missing.length > 0) throw new Refusal(`Nothing is at ${missing.map((path) => `"${path}"`).join(', ')}.`);
}

// Each problem counted under the mod's folder that holds its file, or else under its file's folder.
function countsByFolder(files: readonly string[], modFolders: readonly string[]): { path: string; problems: number }[] {
  const folders = modFolders.map((path) => ({ path, key: keyOf(path) }));
  const counts = new Map<string, number>();
  for (const file of files) {
    const path = folders.find(({ key }) => isAt(keyOf(file), key))?.path ?? dirname(file);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts].map(([path, problems]) => ({ path, problems }));
}

export const PROBLEMS = {
  name: 'list_problems',
  input: { paths: z.array(z.string()).optional() },
  /** `modFolders` are the folders whose problems a reply too large to be useful counts together. */
  of: async ({ paths }: { paths?: string[] }, modFolders: () => readonly string[]) => {
    if (paths !== undefined) await refuseMissing(paths);
    const wanted = paths?.map(keyOf);
    const problems = vscode.languages.getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file' && (wanted === undefined || wanted.some((folder) => isAt(keyOf(uri.fsPath), folder))))
      .flatMap(([uri, diagnostics]) => diagnostics.filter(({ source }) => source === PROBLEM_SOURCE).map(({ severity, range, message, code }) => ({
        file: uri.fsPath, severity: vscode.DiagnosticSeverity[severity], line: range.start.line + 1, message,
        ...code === undefined ? {} : { code: typeof code === 'object' ? code.value : code },
      })));
    return fitting(problems, (all) => ({
      problems: all.length,
      byFolder: countsByFolder(all.map(({ file }) => file), modFolders()),
      narrow: 'paths narrows the read to the files and folders you name.',
    }));
  },
};
