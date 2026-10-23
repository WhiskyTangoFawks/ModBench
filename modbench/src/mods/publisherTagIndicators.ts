// mods.md, Indicators: a badge for each publisher tag that covers a row, as its publisher applies it, and its colour on a
// mod's label.

import * as vscode from 'vscode';
import type { FileOrigin, InstanceValue, InstanceView, Mod, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';
import { IndicatorDecorationProvider, isModRow, modRowUri, PUBLISHER_TAG_INDICATOR, separatorRowUri } from './modIndicators';
import type { WorkspaceSettings } from './workspaceSettings';

type TagsValue = Pick<
  InstanceValue, 'mods' | 'modGroups' | 'filesByMod' | 'foldersByMod' | 'overwriteFiles' | 'overwriteFolders' | 'paths' | 'publisherTags' | 'publisherConfiguration'
>;

// A row's own publisher tags, and those of the rows beneath it, which it carries while collapsed (common.md, A view, story 11).
interface Carried {
  readonly own: ReadonlySet<PublisherTag>;
  readonly beneath: ReadonlySet<PublisherTag>;
}

interface Carriers {
  readonly rows: ReadonlyMap<string, Carried>;
  /** Every row that opens: each mod, separator and folder. */
  readonly openable: ReadonlySet<string>;
}

const foldersAbove = (relativePath: string): string[] => {
  const names = relativePath.split('/');
  return names.slice(1).map((_, depth) => names.slice(0, depth + 1).join('/'));
};

class CarriersRead implements Carriers {
  readonly rows = new Map<string, Carried>();
  readonly openable = new Set<string>();

  constructor(private readonly covering: (path: string, inDisabledMod: boolean) => readonly PublisherTag[]) {}

  /** Each file and folder in `entries`, and answers every publisher tag they carry. */
  origin(origin: FileOrigin, inDisabledMod: boolean, entries: readonly OriginFolder[], folders: readonly OriginFolder[]): Set<PublisherTag> {
    const inOrigin = new Set<PublisherTag>();
    const beneath = new Map<string, Set<PublisherTag>>(folders.map(({ relativePath }) => [relativePath, new Set()]));
    const own = new Map(entries.map((entry) => [entry, this.covering(entry.path, inDisabledMod).filter(({ marksPaths }) => marksPaths)]));
    for (const [entry, tags] of own) {
      this.carry(vscode.Uri.file(entry.path).toString(), tags);
      for (const tag of tags) inOrigin.add(tag);
      for (const above of foldersAbove(entry.relativePath)) for (const tag of tags) beneath.get(above)?.add(tag);
    }
    for (const [entry, tags] of own) {
      const key = fileRowUri(origin, entry.relativePath).toString();
      this.carry(key, tags, beneath.get(entry.relativePath));
      if (beneath.has(entry.relativePath)) this.openable.add(key);
    }
    return inOrigin;
  }

  /** The mod's row, and answers every publisher tag it carries while collapsed. */
  mod(mod: Mod, folder: string | undefined, filesBeneath: ReadonlySet<PublisherTag>): Set<PublisherTag> {
    const own = folder === undefined ? [] : this.covering(folder, !mod.enabled);
    this.openableRow(modRowUri(mod.name).toString(), own, filesBeneath);
    return new Set([...own, ...filesBeneath]);
  }

  openableRow(key: string, own: Iterable<PublisherTag>, beneath: Iterable<PublisherTag>): void {
    this.carry(key, own, beneath);
    this.openable.add(key);
  }

  private carry(key: string, own: Iterable<PublisherTag>, beneath: Iterable<PublisherTag> = []): void {
    const carried = { own: new Set(own), beneath: new Set(beneath) };
    if (carried.own.size + carried.beneath.size > 0) this.rows.set(key, carried);
  }
}

function carriersOf(value: TagsValue): Carriers {
  const configuration = value.publisherConfiguration;
  const carriers = new CarriersRead(configuration.kind === 'read' ? (path, inDisabledMod) => configuration.covering(path, inDisabledMod) : () => []);
  const carriedByMod = new Map<string, Set<PublisherTag>>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod') continue;
    const folders = value.foldersByMod.get(entry.name) ?? [];
    const filesBeneath = carriers.origin(modOrigin(entry.name), !entry.enabled, [...(value.filesByMod.get(entry.name) ?? []), ...folders], folders);
    carriedByMod.set(entry.name, carriers.mod(entry, value.paths.modDirs.get(entry.name), filesBeneath));
  }
  carriers.origin(RUNTIME_OUTPUT, false, [...value.overwriteFiles, ...value.overwriteFolders], value.overwriteFolders);
  for (const { separator, mods } of value.modGroups.groups) {
    carriers.openableRow(separatorRowUri(separator.name).toString(), [], mods.flatMap(({ name }) => [...(carriedByMod.get(name) ?? [])]));
  }
  return carriers;
}

/** One provider for each publisher tag the publisher declares. Each fires on every new instance value (ADR-0003), setting
 *  change, and row opened or closed. */
export class PublisherTagDecorations implements vscode.Disposable {
  readonly providers: readonly IndicatorDecorationProvider[];
  private carriers: Carriers | undefined;
  private readonly expanded = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings) {
    const carries = (tag: PublisherTag) => (uri: vscode.Uri): boolean => {
      this.carriers ??= carriersOf(instance.value);
      const key = uri.toString();
      const carried = this.carriers.rows.get(key);
      return carried !== undefined && (carried.own.has(tag) || (!this.expanded.has(key) && carried.beneath.has(tag)));
    };
    this.providers = instance.value.publisherTags.map((tag) => new IndicatorDecorationProvider(
      { id: PUBLISHER_TAG_INDICATOR.id, name: tag.name, badge: tag.badge, colour: PUBLISHER_TAG_INDICATOR.colour }, carries(tag), settings, isModRow,
    ));
    this.subscription = instance.subscribe((value) => {
      this.carriers = carriersOf(value);
      for (const key of this.expanded) if (!this.carriers.openable.has(key)) this.expanded.delete(key);
      this.refresh();
    });
  }

  expandedRow(uri: vscode.Uri): void {
    this.expanded.add(uri.toString());
    this.refresh();
  }

  collapsedRow(uri: vscode.Uri): void {
    this.expanded.delete(uri.toString());
    this.refresh();
  }

  private refresh(): void {
    for (const provider of this.providers) provider.refresh();
  }

  dispose(): void {
    this.subscription.dispose();
    for (const provider of this.providers) provider.dispose();
  }
}
