import { dirname, normalize, sep } from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';
import { Refusal } from '../drivingLib/refusal';
import { countsOf, fitting } from './tooLarge';

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

function holdingFolder(common: string, file: string): string {
  let folder = common;
  while (!isAt(keyOf(file), keyOf(folder)) && dirname(folder) !== folder) folder = dirname(folder);
  return folder;
}

function countsByFolder(files: readonly string[], known: readonly string[]): Record<string, string | number>[] {
  const folders = known.map((path) => ({ path, key: keyOf(path) }));
  const placed = files.map((file) => ({ file, folder: folders.find(({ key }) => isAt(keyOf(file), key))?.path }));
  const elsewhere = placed.flatMap(({ file, folder }) => (folder === undefined ? [file] : []));
  const common = elsewhere.reduce(holdingFolder, dirname(elsewhere[0] ?? ''));
  return countsOf(placed.map(({ folder }) => folder ?? common), 'path');
}

export const PROBLEMS = {
  name: 'list_problems',
  input: { paths: z.array(z.string()).optional() },
  /** `folders` are those whose problems a reply too large to be useful counts together. The problems in none of them
   *  are counted together under the folder that holds them all. */
  of: async ({ paths }: { paths?: string[] }, folders: () => readonly string[]) => {
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
      byFolder: countsByFolder(all.map(({ file }) => file), folders()),
      narrow: 'paths narrows the read to the files and folders you name.',
    }));
  },
};
