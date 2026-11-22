// common.md, A view, story 13: a new value asks again for the rows of the origins it touches alone.

import type * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, Mod, OriginFile } from '../instanceLoader/instance';
import { modOrigin, originKey, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { changedKeys } from '../ports/lastBuilt';

const BY_ORIGIN: readonly (keyof InstanceValue)[] = ['filesByMod', 'foldersByMod', 'overwriteFiles', 'overwriteFolders', 'files', 'stackedCopies'];

/** What an origin's rows show of its files: the archives and what each holds reach them through the stack. */
export type Touching = Pick<InstanceValue, 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders' | 'files' | 'stackedCopies' | 'archiveContents' | 'loadsArchive'>;

/** The facts every origin's rows follow. */
export const TOUCHING_READ = {
  filesByMod: true, foldersByMod: true, overwriteFiles: true, overwriteFolders: true, files: true, stackedCopies: true, archiveContents: true, loadsArchive: true,
} as const satisfies Record<keyof Touching, true>;

// Whether a fact no origin's rows are keyed by changed: the archives, or another fact `reads` names.
function changedBeyond<K extends keyof InstanceValue>(before: Pick<InstanceValue, K> & Touching, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>): boolean {
  const isRead = (fact: string): fact is K => fact in reads;
  return before.archiveContents !== after.archiveContents || before.loadsArchive !== after.loadsArchive
    || Object.keys(reads).filter(isRead).some((fact) => !BY_ORIGIN.includes(fact) && before[fact] !== after[fact]);
}

// Each origin whose own files or folders changed, with the files it holds and held.
function ownChanged(before: Touching, after: Touching): [FileOrigin, OriginFile[]][] {
  const mods = [...new Set([...changedKeys(after.filesByMod, before.filesByMod), ...changedKeys(after.foldersByMod, before.foldersByMod)])];
  const overwrite = before.overwriteFiles !== after.overwriteFiles || before.overwriteFolders !== after.overwriteFolders;
  return [
    ...mods.map((name): [FileOrigin, OriginFile[]] => [modOrigin(name), [...before.filesByMod.get(name) ?? [], ...after.filesByMod.get(name) ?? []]]),
    ...overwrite ? [[RUNTIME_OUTPUT, [...before.overwriteFiles, ...after.overwriteFiles]] satisfies [FileOrigin, OriginFile[]]] : [],
  ];
}

// Each origin with a copy of the path, loose or archived.
const providersAt = (value: Touching, path: string): FileOrigin[] =>
  [...value.files.get(path)?.providers ?? [], ...(value.stackedCopies.get(path)?.copies ?? []).map(({ origin }) => origin)];

/** The origins whose rows a new value changes: each whose own files or folders changed, Overwrite among them, and each
 *  that provides a path they hold or held. Every origin's while the archives or another fact `reads` names changed. */
export function originsTouched<K extends keyof InstanceValue>(
  before: Pick<InstanceValue, K> & Touching | undefined, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>,
): 'every' | readonly FileOrigin[] {
  if (before === undefined || changedBeyond(before, after, reads)) return 'every';
  const own = ownChanged(before, after);
  if (own.length === 0) return before.files === after.files && before.stackedCopies === after.stackedCopies ? [] : 'every';
  const touched = new Map(own.map(([origin]) => [originKey(origin), origin]));
  const paths = new Set(own.flatMap(([, files]) => files.map(({ relativePath }) => relativePath)));
  for (const path of paths) for (const origin of [before, after].flatMap((value) => providersAt(value, path))) touched.set(originKey(origin), origin);
  return [...touched.values()];
}

/** The origins a value touches among those `value` lists: a mod by its entry, Overwrite as it is. */
export const touchedIn = (value: Pick<InstanceValue, 'mods'>, touched: 'every' | readonly FileOrigin[]): readonly FileOrigin[] => (touched !== 'every' ? touched
  : [...value.mods.flatMap((entry): FileOrigin[] => (entry.kind === 'mod' ? [modOrigin(entry.name)] : [])), RUNTIME_OUTPUT]);

const entriesOf = new WeakMap<InstanceValue['mods'], ReadonlyMap<string, Mod>>();

/** The mod the order lists under `name`. */
export function modEntryOf(mods: InstanceValue['mods'], name: string): Mod | undefined {
  let entries = entriesOf.get(mods);
  if (entries === undefined) {
    entries = new Map(mods.flatMap((entry) => (entry.kind === 'mod' ? [[entry.name, entry] as const] : [])));
    entriesOf.set(mods, entries);
  }
  return entries.get(name);
}

/** A row VS Code asks a decoration of, and what it carries. */
export interface Row<D> {
  readonly uri: vscode.Uri;
  readonly carried: D;
}

/** The rows the origin or separator that `owner` names gives. */
export type Owned<D> = readonly [owner: string, rows: ReadonlyMap<string, Row<D>>];

/** Rows kept by the origin or separator that gives them, so a new value derives again the rows of the owners it touches. */
export class RowsByOwner<D> {
  private readonly rows = new Map<string, Row<D>>();
  private readonly byOwner = new Map<string, ReadonlyMap<string, Row<D>>>();

  constructor(private readonly same: (a: D, b: D) => boolean) {}

  get(key: string): D | undefined {
    return this.rows.get(key)?.carried;
  }

  /** Holds the rows each owner gives, in place of those it gave, and answers each row whose decoration changed. */
  hold(owned: Iterable<Owned<D>>): vscode.Uri[] {
    const changed: vscode.Uri[] = [];
    for (const [owner, now] of owned) {
      const was = this.byOwner.get(owner) ?? new Map<string, Row<D>>();
      for (const [key, row] of was) {
        if (now.has(key)) continue;
        this.rows.delete(key);
        changed.push(row.uri);
      }
      for (const [key, row] of now) {
        const prior = was.get(key);
        this.rows.set(key, row);
        if (prior === undefined || !this.same(prior.carried, row.carried)) changed.push(row.uri);
      }
      this.byOwner.set(owner, now);
    }
    return changed;
  }

  clear(): void {
    this.rows.clear();
    this.byOwner.clear();
  }
}

/** Keeps `rows` current: each value derives again the rows of the owners it touches, and tells `refresh` the rows whose
 *  decoration changed, or nothing for every row. `held` answers the rows, deriving them first from the instance's value. */
export function rowsFollowing<D, K extends keyof InstanceValue>(
  instance: Pick<InstanceView, 'value' | 'subscribe'>, concerns: Readonly<Record<K | keyof Touching, true>>, rows: RowsByOwner<D>,
  ownedAgain: (value: Pick<InstanceValue, K | keyof Touching>, touched: 'every' | readonly FileOrigin[]) => Iterable<Owned<D>>,
  refresh: (uris?: vscode.Uri[]) => void,
): { readonly subscription: { dispose(): unknown }; readonly held: () => RowsByOwner<D> } {
  let held: Pick<InstanceValue, K | keyof Touching> | undefined;
  const subscription = instance.subscribe((value) => {
    const touched = originsTouched(held, value, concerns);
    if (touched === 'every') rows.clear();
    held = value;
    const changed = rows.hold(ownedAgain(value, touched));
    if (touched === 'every') refresh();
    else if (changed.length > 0) refresh(changed);
  }, concerns);
  return {
    subscription,
    held: () => {
      if (held === undefined) {
        held = instance.value;
        rows.hold(ownedAgain(instance.value, 'every'));
      }
      return rows;
    },
  };
}
