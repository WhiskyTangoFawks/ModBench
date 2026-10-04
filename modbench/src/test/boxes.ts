// The Modbench column of the zoom-out, docs/architecture/target-architecture.d2, joined to the
// box folders on disk; a box's references are its tsconfig's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..');
const ZOOM_OUT = join(SRC, '..', '..', 'docs', 'architecture', 'target-architecture.d2');

function boxIdsByBand(): Record<string, string[]> {
  const bands: Record<string, string[]> = {};
  let band: string | undefined;
  for (const line of readFileSync(ZOOM_OUT, 'utf8').split('\n')) {
    const container = /^modbench_(\w+): "/.exec(line);
    if (container) {
      band = container[1];
      bands[band] = [];
      continue;
    }
    if (/^\w/.test(line)) band = undefined;
    const member = /^ {2}(\w+): "/.exec(line);
    if (member && band) bands[band].push(member[1]);
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
export const BELOW_THE_CORE: string[] = [...(BOXES_BY_BAND.readmodel ?? []), ...(BOXES_BY_BAND.repositories ?? [])];
export const REFERENCING_BOXES: string[] = [...DRIVING_BOXES, ...CORE_BOXES, ...BELOW_THE_CORE];
export const BOXES: string[] = [...KERNEL_BOXES, ...REFERENCING_BOXES];

export function referencesOf(box: string): string[] {
  const path = join(SRC, box, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' ')); },
  });
  return (parsed?.projectReferences ?? []).map((r) => basename(r.path)).sort();
}
