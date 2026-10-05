// The Modbench column of the zoom-out, docs/architecture/target-architecture.d2, joined to the
// box folders on disk; a box's references are its tsconfig's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { SRC } from './scanSource';

const ZOOM_OUT = join(SRC, '..', '..', 'docs', 'architecture', 'target-architecture.d2');

function boxIdsByBand(): Record<string, string[]> {
  const bands: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of readFileSync(ZOOM_OUT, 'utf8').split('\n')) {
    const container = /^modbench_(\w+): "/.exec(line)?.[1];
    if (container !== undefined) {
      current = [];
      bands[container] = current;
      continue;
    }
    if (/^\w/.test(line)) current = undefined;
    const member = /^ {2}(\w+): "/.exec(line)?.[1];
    if (member !== undefined && current !== undefined) current.push(member);
  }
  return bands;
}

export const PROJECT_FOLDERS: string[] = readdirSync(SRC, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'test' && existsSync(join(SRC, entry.name, 'tsconfig.json')))
  .map((entry) => entry.name)
  .sort();

const folderOf = (id: string): string | undefined => PROJECT_FOLDERS.find((folder) => folder.toLowerCase() === id);

export const BOXES_BY_BAND: Record<string, string[]> = Object.fromEntries(
  Object.entries(boxIdsByBand()).map(([band, ids]) => [band, ids.map(folderOf).filter((f): f is string => f !== undefined)]),
);

export const KERNEL_BOXES: string[] = BOXES_BY_BAND.kernel ?? [];
export const DRIVING_BOXES: string[] = BOXES_BY_BAND.driving ?? [];
export const CORE_BOXES: string[] = BOXES_BY_BAND.core ?? [];
export const READ_MODEL_AND_REPOSITORY_BOXES: string[] = [...(BOXES_BY_BAND.readmodel ?? []), ...(BOXES_BY_BAND.repositories ?? [])];
export const REFERENCING_BOXES: string[] = [...DRIVING_BOXES, ...CORE_BOXES, ...READ_MODEL_AND_REPOSITORY_BOXES];
export const BOXES: string[] = [...KERNEL_BOXES, ...REFERENCING_BOXES];

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
