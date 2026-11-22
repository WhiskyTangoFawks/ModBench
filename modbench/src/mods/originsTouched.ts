// common.md, A view, story 13: a new value asks again for the rows of the origins it touches alone.

import type { FileOrigin, InstanceValue } from '../instanceLoader/instance';
import { modOrigin, originKey } from '../instanceLoader/fileConflictIndex';
import { changedKeys } from '../ports/lastBuilt';

const BY_ORIGIN: readonly (keyof InstanceValue)[] = ['filesByMod', 'foldersByMod', 'files', 'stackedCopies'];

/** What an origin's rows show of its files: the archives and what each holds reach them through the stack. */
export type Touching = Pick<InstanceValue, 'filesByMod' | 'foldersByMod' | 'files' | 'stackedCopies' | 'archiveContents' | 'loadsArchive'>;

/** The origins whose rows a new value changes: each whose own files or folders changed, and each that
 *  provides a path they hold or held. Every origin's while another fact `reads` names changed, or the archives did. */
export function originsTouched<K extends keyof InstanceValue>(
  before: Pick<InstanceValue, K> & Touching | undefined, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>,
): 'every' | readonly FileOrigin[] {
  if (before === undefined || changedBeyond(before, after, reads)) return 'every';
  const mods = [...new Set([...changedKeys(after.filesByMod, before.filesByMod), ...changedKeys(after.foldersByMod, before.foldersByMod)])];
  if (mods.length === 0) return before.files === after.files && before.stackedCopies === after.stackedCopies ? [] : 'every';
  const touched = new Map(mods.map((name) => [originKey(modOrigin(name)), modOrigin(name)]));
  const paths = new Set(mods.flatMap((name) => [before, after].flatMap((value) => (value.filesByMod.get(name) ?? []).map(({ relativePath }) => relativePath))));
  for (const path of paths) for (const origin of [before, after].flatMap((value) => providersAt(value, path))) touched.set(originKey(origin), origin);
  return [...touched.values()];
}

// Whether a fact no origin's rows are keyed by changed: the archives, or another fact `reads` names.
function changedBeyond<K extends keyof InstanceValue>(before: Pick<InstanceValue, K> & Touching, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>): boolean {
  const isRead = (fact: string): fact is K => fact in reads;
  return before.archiveContents !== after.archiveContents || before.loadsArchive !== after.loadsArchive
    || Object.keys(reads).filter(isRead).some((fact) => !BY_ORIGIN.includes(fact) && before[fact] !== after[fact]);
}

// Each origin with a copy of the path, loose or archived.
const providersAt = (value: Touching, path: string): FileOrigin[] =>
  [...value.files.get(path)?.providers ?? [], ...(value.stackedCopies.get(path)?.copies ?? []).map(({ origin }) => origin)];
