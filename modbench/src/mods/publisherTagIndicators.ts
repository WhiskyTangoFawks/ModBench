// mods.md, Indicators: a badge for each publisher tag that covers a row, as its publisher applies it, and its colour on a
// mod's label.

import * as vscode from 'vscode';
import type { Covering, FileOrigin, InstanceValue, InstanceView, OriginFile, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { originKey, sameOrigin } from '../instanceLoader/fileConflictIndex';
import { pathTagsOf } from './modFileStates';
import { fileRowUri } from './modFiles';
import {
  IndicatorDecorationProvider, isModRow, modRowUri, OpenableRowDecorations, overwriteRowUri, PUBLISHER_TAG_INDICATOR, separatorOf, separatorRowUri,
} from './modIndicators';
import { touchedIn, type OriginsChange, type Owned, type Row } from './originsTouched';
import { TOUCHING_READ, type FilesChanged } from '../instanceLoader/filesChanged';
import type { OpenRows } from './openRows';
import type { WorkspaceSettings } from './workspaceSettings';

// A row's own publisher tags, and those of the rows beneath it, which it carries while collapsed (common.md, A view, story 11).
interface Carried {
  readonly own: ReadonlySet<PublisherTag>;
  readonly beneath: ReadonlySet<PublisherTag>;
}

const sameTags = (a: ReadonlySet<PublisherTag>, b: ReadonlySet<PublisherTag>): boolean => a.size === b.size && [...a].every((tag) => b.has(tag));

const sameCarried = (a: Carried, b: Carried): boolean => sameTags(a.own, b.own) && sameTags(a.beneath, b.beneath);

const foldersAbove = (relativePath: string): string[] => {
  const names = relativePath.split('/');
  return names.slice(1).map((_, depth) => names.slice(0, depth + 1).join('/'));
};

const CARRIERS_READ = { ...TOUCHING_READ, publisherConfiguration: true, mods: true, paths: true, modGroups: true } as const;

type CarriersValue = Pick<InstanceValue, keyof typeof CARRIERS_READ>;

type OwnChange = Exclude<FilesChanged, 'every'>[number];

const rowsOf = (...rows: readonly (readonly [vscode.Uri, Iterable<PublisherTag>, Iterable<PublisherTag>])[]): Map<string, Row<Carried>> =>
  new Map(rows.flatMap(([uri, own, beneath]) => {
    const carried = { own: new Set(own), beneath: new Set(beneath) };
    return carried.own.size + carried.beneath.size > 0 ? [[uri.toString(), { uri, carried }] as const] : [];
  }));

// The tags of an origin's entries beneath each of its folders and beneath the origin, by how many entries carry each:
// kept so a change counts again only the entries it gained or lost (ADR-0029, Consequences, bullet 5).
class Beneath {
  private readonly counts = new Map<string, Map<PublisherTag, number>>();
  private folders: readonly OriginFolder[] = [];
  readonly listed = new Map<string, OriginFolder>();

  constructor(readonly tagsOf: (entry: OriginFolder) => readonly PublisherTag[]) {}

  of(folder: string): PublisherTag[] {
    return [...this.counts.get(folder) ?? []].flatMap(([tag, count]) => (count > 0 ? [tag] : []));
  }

  /** Counts every file, and answers each as a row to derive again. */
  taken(files: readonly OriginFile[]): Map<string, OriginFolder | undefined> {
    for (const file of files) this.count(file, 1);
    return new Map(files.map((file) => [file.relativePath, file]));
  }

  /** Counts again each file a change gained or lost, and answers it and each listed folder above it as a row to derive
   *  again: a file lost alone has none. */
  changed({ files, gained }: OwnChange): Map<string, OriginFolder | undefined> {
    const kept = new Set(gained);
    const again = new Map<string, OriginFolder | undefined>();
    for (const file of files) this.count(file, kept.has(file) ? 1 : -1);
    for (const file of files) {
      if (kept.has(file) || !again.has(file.relativePath)) again.set(file.relativePath, kept.has(file) ? file : undefined);
      for (const above of foldersAbove(file.relativePath)) if (!again.has(above)) again.set(above, this.listed.get(above));
    }
    return again;
  }

  /** Counts the folders again once they are another list, and answers each folder held or listed, and each above them. */
  refolded(folders: readonly OriginFolder[]): Map<string, OriginFolder | undefined> {
    if (folders === this.folders) return new Map();
    const both = [...this.folders, ...folders];
    for (const folder of this.folders) this.count(folder, -1);
    for (const folder of folders) this.count(folder, 1);
    this.folders = folders;
    this.listed.clear();
    for (const folder of folders) this.listed.set(folder.relativePath, folder);
    return new Map(both.flatMap((folder) => [folder.relativePath, ...foldersAbove(folder.relativePath)]).map((path) => [path, this.listed.get(path)]));
  }

  private count(entry: OriginFolder, by: number): void {
    const tags = this.tagsOf(entry);
    for (const folder of ['', ...foldersAbove(entry.relativePath)]) {
      const counts = this.counts.get(folder) ?? new Map<PublisherTag, number>();
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + by);
      this.counts.set(folder, counts);
    }
  }
}

// The rows of an entry: its file's, and its row's, which carries a listed folder's tags beneath; none for an entry lost.
function entryRows(origin: FileOrigin, entry: OriginFolder | undefined, beneath: Beneath): Map<string, Row<Carried>> {
  if (entry === undefined) return new Map();
  const own = beneath.tagsOf(entry);
  const below = beneath.listed.has(entry.relativePath) ? beneath.of(entry.relativePath) : [];
  return rowsOf([vscode.Uri.file(entry.path), own, []], [fileRowUri(origin, entry.relativePath), own, below]);
}

const originRowUri = (origin: FileOrigin): vscode.Uri => (origin.kind === 'mod' ? modRowUri(origin.name) : overwriteRowUri());

// A mod's own tags, those covering its folder; Overwrite carries none of its own.
function originTags(value: CarriersValue, origin: FileOrigin, covering: Covering): readonly PublisherTag[] {
  const folder = origin.kind === 'mod' ? value.paths.modDirs.get(origin.name) : undefined;
  return origin.kind === 'mod' && folder !== undefined ? covering(folder, origin.name) : [];
}

// The files and folders of an origin, and the mod its publisher tags are judged under.
function entriesOf(value: CarriersValue, origin: FileOrigin): { files: readonly OriginFile[]; folders: readonly OriginFolder[]; mod: string | undefined } {
  return origin.kind === 'mod'
    ? { files: value.filesByMod.get(origin.name) ?? [], folders: value.foldersByMod.get(origin.name) ?? [], mod: origin.name }
    : { files: value.overwriteFiles, folders: value.overwriteFolders, mod: undefined };
}

/** One provider for each publisher tag the publisher declares. */
export class PublisherTagDecorations extends OpenableRowDecorations<Carried, keyof typeof CARRIERS_READ> {
  readonly providers: readonly IndicatorDecorationProvider[];
  private readonly kept = new Map<string, Beneath>();

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, open: OpenRows, settings: WorkspaceSettings) {
    super(instance, open, CARRIERS_READ, sameCarried);
    const carries = (tag: PublisherTag) => (uri: vscode.Uri): boolean => {
      const key = uri.toString();
      const carried = this.carried(key);
      return carried !== undefined && (carried.own.has(tag) || (!this.isOpen(key) && carried.beneath.has(tag)));
    };
    this.providers = instance.value.publisherTags.map((tag) => new IndicatorDecorationProvider(
      { id: PUBLISHER_TAG_INDICATOR.id, name: tag.name, badge: tag.badge, colour: PUBLISHER_TAG_INDICATOR.colour }, carries(tag), settings, isModRow,
    ));
  }

  // A separator carries beneath it what each mod it holds carries. An origin's tags follow its own entries alone.
  protected * ownedAgain(value: CarriersValue, change: OriginsChange): Iterable<Owned<Carried>> {
    if (change === 'every') this.kept.clear();
    const origins = change === 'every' ? touchedIn(value, change) : change.own.map(({ origin }) => origin);
    for (const origin of origins) yield * this.ownedBy(value, origin, change === 'every' ? undefined : change.own.find((own) => sameOrigin(own.origin, origin)));
    const mods = origins.flatMap((origin) => (origin.kind === 'mod' ? [origin.name] : []));
    const separators = new Set(mods.flatMap((name) => separatorOf(value.modGroups, name) ?? []));
    for (const { separator, mods: held } of value.modGroups.groups) {
      if (!separators.has(separator.name)) continue;
      const carried = held.flatMap(({ name }) => {
        const row = this.rows.get(modRowUri(name).toString());
        return row === undefined ? [] : [...row.own, ...row.beneath];
      });
      yield [`separator/${separator.name}`, rowsOf([separatorRowUri(separator.name), [], carried])];
    }
  }

  // The rows of the entries of an origin a change gained or lost, of each folder above them, and of the origin; every row
  // of it while nothing of it is kept.
  private * ownedBy(value: CarriersValue, origin: FileOrigin, own: OwnChange | undefined): Iterable<Owned<Carried>> {
    const covering = value.publisherConfiguration.kind === 'read' ? value.publisherConfiguration.covering : () => [];
    const { files, folders, mod } = entriesOf(value, origin);
    const tagsOf = (entry: OriginFolder): PublisherTag[] => pathTagsOf(covering, entry.path, mod);
    const key = originKey(origin);
    const kept = own === undefined ? undefined : this.kept.get(key);
    const beneath = kept ?? new Beneath(tagsOf);
    this.kept.set(key, beneath);
    const again = kept === undefined || own === undefined ? beneath.taken(files) : beneath.changed(own);
    for (const [relativePath, entry] of beneath.refolded(folders)) again.set(relativePath, entry);
    for (const [relativePath, entry] of again) yield [`${key}\0${relativePath}`, entryRows(origin, entry, beneath)];
    yield [key, rowsOf([originRowUri(origin), originTags(value, origin, covering), beneath.of('')])];
  }


}
