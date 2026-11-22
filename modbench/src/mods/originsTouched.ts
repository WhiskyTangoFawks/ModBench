// common.md, A view, story 13: a new value asks again for the rows of the origins it touches alone.

import type * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, Mod } from '../instanceLoader/instance';
import { modOrigin, originKey, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { filesChanged, type FilesChanged, type Touching } from '../instanceLoader/filesChanged';

// Each origin with a copy of the path, loose or archived.
const providersAt = (value: Touching, path: string): FileOrigin[] =>
  [...value.files.get(path)?.providers ?? [], ...(value.stackedCopies.get(path)?.copies ?? []).map(({ origin }) => origin)];

/** What a new value changed of the origins: anything, or the origins whose rows it changes, each path whose copies it
 *  changed, and each origin's own files it gained or lost. */
export type OriginsChange = 'every' | {
  readonly origins: readonly FileOrigin[];
  readonly paths: ReadonlySet<string>;
  readonly own: Exclude<FilesChanged, 'every'>;
};

/** The change a new value makes: each origin whose own files changed, and each that provides a path they gained or lost.
 *  Anything while `filesChanged` says anything changed. */
export function changeOf<K extends keyof InstanceValue>(
  before: Pick<InstanceValue, K> & Touching | undefined, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>,
): OriginsChange {
  const own = filesChanged(before, after, reads);
  if (own === 'every' || before === undefined) return 'every';
  const touched = new Map(own.map(({ origin }) => [originKey(origin), origin]));
  const paths = new Set(own.flatMap(({ files }) => files.map(({ relativePath }) => relativePath)));
  for (const path of paths) for (const origin of [before, after].flatMap((value) => providersAt(value, path))) touched.set(originKey(origin), origin);
  return { origins: [...touched.values()], paths, own };
}

/** The origins whose rows a new value changes, as `changeOf` tells them. */
export function originsTouched<K extends keyof InstanceValue>(
  before: Pick<InstanceValue, K> & Touching | undefined, after: Pick<InstanceValue, K> & Touching, reads: Readonly<Record<K, true>>,
): 'every' | readonly FileOrigin[] {
  const change = changeOf(before, after, reads);
  return change === 'every' ? 'every' : change.origins;
}

/** The origins a change touches among those `value` lists: a mod by its entry, Overwrite as it is. */
export const touchedIn = (value: Pick<InstanceValue, 'mods'>, change: OriginsChange): readonly FileOrigin[] => (change !== 'every' ? change.origins
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
  ownedAgain: (value: Pick<InstanceValue, K | keyof Touching>, change: OriginsChange) => Iterable<Owned<D>>,
  refresh: (uris?: vscode.Uri[]) => void,
): { readonly subscription: { dispose(): unknown }; readonly held: () => RowsByOwner<D> } {
  let held: Pick<InstanceValue, K | keyof Touching> | undefined;
  const subscription = instance.subscribe((value) => {
    const change = changeOf(held, value, concerns);
    if (change === 'every') rows.clear();
    held = value;
    const changed = rows.hold(ownedAgain(value, change));
    if (change === 'every') refresh();
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
