import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { SRC } from './scanSource';

export function parseProject(path: string): ts.ParsedCommandLine {
  const result = ts.getParsedCommandLineOfConfigFile(path, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' ')); },
  });
  if (!result) throw new Error(`No parsed command line for ${path}`);
  return result;
}

export interface Box {
  name: string;
  references: Set<string>;
}

function referencePaths(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || !('references' in config)) return [];
  const { references } = config;
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference: unknown) =>
    (typeof reference === 'object' && reference !== null && 'path' in reference && typeof reference.path === 'string'
      ? [reference.path] : []));
}

export function boxesIn(src: string = SRC): Box[] {
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(src, entry.name, 'tsconfig.json')))
    .map((entry) => {
      const path = join(src, entry.name, 'tsconfig.json');
      const read: { config?: unknown; error?: ts.Diagnostic } = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
      if (read.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
      return { name: entry.name, references: new Set(referencePaths(read.config).map((r) => basename(r))) };
    });
}

export const referencesOf = (box: string, src: string = SRC): string[] =>
  [...(boxesIn(src).find((b) => b.name === box)?.references ?? [])].sort();
