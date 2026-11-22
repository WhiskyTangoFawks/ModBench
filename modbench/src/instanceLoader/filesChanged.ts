// ADR-0029, Consequences, bullet 5: what derives from an origin's files updates from the origins whose files changed.

import type { FileOrigin, OriginFile } from '../instanceAdapter/instanceAdapter';
import { modOrigin, RUNTIME_OUTPUT } from './fileConflictIndex';
import { changedKeys } from '../ports/lastBuilt';
import type { InstanceValue } from './instance';

const BY_ORIGIN: readonly (keyof InstanceValue)[] = ['filesByMod', 'foldersByMod', 'overwriteFiles', 'overwriteFolders', 'files', 'stackedCopies'];

/** What an origin's files are, and what the game gets of them: the archives and what each holds reach them through the stack. */
export type Touching = Pick<InstanceValue, 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders' | 'files' | 'stackedCopies' | 'archiveContents' | 'loadsArchive'>;

/** The facts whatever follows the origins' files reads. */
export const TOUCHING_READ = {
  filesByMod: true, foldersByMod: true, overwriteFiles: true, overwriteFolders: true, files: true, stackedCopies: true, archiveContents: true, loadsArchive: true,
} as const satisfies Record<keyof Touching, true>;

// An origin whose own files or folders changed, Overwrite among them, with the files it holds and held.
interface OwnFilesChanged {
  readonly origin: FileOrigin;
  readonly files: readonly OriginFile[];
}

/** Each origin whose own files changed, or anything. */
export type FilesChanged = 'every' | readonly OwnFilesChanged[];

// Whether a fact no origin's files hold changed: the archives, or another fact `reads` names.
function changedBeyond<K extends keyof InstanceValue>(before: Pick<InstanceValue, K> & Touching, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>): boolean {
  const isRead = (fact: string): fact is K => fact in reads;
  return before.archiveContents !== after.archiveContents || before.loadsArchive !== after.loadsArchive
    || Object.keys(reads).filter(isRead).some((fact) => !BY_ORIGIN.includes(fact) && before[fact] !== after[fact]);
}

/** What a new value changed of the origins' files. Anything while the archives or another fact `reads` names changed, or
 *  the stack changed with no origin's files. */
export function filesChanged<K extends keyof InstanceValue>(
  before: Pick<InstanceValue, K> & Touching | undefined, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>,
): FilesChanged {
  if (before === undefined || changedBeyond(before, after, reads)) return 'every';
  const mods = [...new Set([...changedKeys(after.filesByMod, before.filesByMod), ...changedKeys(after.foldersByMod, before.foldersByMod)])];
  const overwrite = before.overwriteFiles !== after.overwriteFiles || before.overwriteFolders !== after.overwriteFolders;
  const own = [
    ...mods.map((name) => ({ origin: modOrigin(name), files: [...before.filesByMod.get(name) ?? [], ...after.filesByMod.get(name) ?? []] })),
    ...overwrite ? [{ origin: RUNTIME_OUTPUT, files: [...before.overwriteFiles, ...after.overwriteFiles] }] : [],
  ];
  if (own.length > 0) return own;
  return before.files === after.files && before.stackedCopies === after.stackedCopies ? [] : 'every';
}
