import { normalize, sep } from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';
import { Refusal } from '../drivingLib/refusal';

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

export const PROBLEMS = {
  name: 'list_problems',
  input: { paths: z.array(z.string()).optional() },
  of: async ({ paths }: { paths?: string[] }) => {
    if (paths !== undefined) await refuseMissing(paths);
    const wanted = paths?.map(keyOf);
    return vscode.languages.getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file' && (wanted === undefined || wanted.some((folder) => isAt(keyOf(uri.fsPath), folder))))
      .flatMap(([uri, diagnostics]) => diagnostics.filter(({ source }) => source === PROBLEM_SOURCE).map(({ severity, range, message, code }) => ({
        file: uri.fsPath, severity: vscode.DiagnosticSeverity[severity], line: range.start.line + 1, message,
        ...code === undefined ? {} : { code: typeof code === 'object' ? code.value : code },
      })));
  },
};
