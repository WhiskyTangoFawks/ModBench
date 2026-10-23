// mods.md, Indicators: a badge for each publisher tag that covers a row, as its publisher applies it, and its colour on a
// mod's label.

import * as vscode from 'vscode';
import type { Covering, FileOrigin, InstanceValue, InstanceView, OriginFolder, PublisherTag } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';
import {
  IndicatorDecorationProvider, isModRow, modRowUri, OpenableRowDecorations, overwriteRowUri, PUBLISHER_TAG_INDICATOR, separatorRowUri,
} from './modIndicators';
import type { WorkspaceSettings } from './workspaceSettings';

// A row's own publisher tags, and those of the rows beneath it, which it carries while collapsed (common.md, A view, story 11).
interface Carried {
  readonly own: ReadonlySet<PublisherTag>;
  readonly beneath: ReadonlySet<PublisherTag>;
}

interface Carriers {
  readonly rows: ReadonlyMap<string, Carried>;
  readonly openable: ReadonlySet<string>;
}

const foldersAbove = (relativePath: string): string[] => {
  const names = relativePath.split('/');
  return names.slice(1).map((_, depth) => names.slice(0, depth + 1).join('/'));
};

class CarriersRead implements Carriers {
  readonly rows = new Map<string, Carried>();
  readonly openable = new Set<string>();

  constructor(readonly covering: Covering) {}

  carryFilesAndFolders(
    origin: FileOrigin, mod: string | undefined, entries: readonly OriginFolder[], folders: readonly OriginFolder[],
  ): Set<PublisherTag> {
    const inOrigin = new Set<PublisherTag>();
    const beneath = new Map<string, Set<PublisherTag>>(folders.map(({ relativePath }) => [relativePath, new Set()]));
    const own = new Map(entries.map((entry) => [entry, this.covering(entry.path, mod).filter(({ marksPaths }) => marksPaths)]));
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

  carryOpenableRow(key: string, own: Iterable<PublisherTag>, beneath: Iterable<PublisherTag>): Set<PublisherTag> {
    this.carry(key, own, beneath);
    this.openable.add(key);
    return new Set([...own, ...beneath]);
  }

  private carry(key: string, own: Iterable<PublisherTag>, beneath: Iterable<PublisherTag> = []): void {
    const carried = { own: new Set(own), beneath: new Set(beneath) };
    if (carried.own.size + carried.beneath.size > 0) this.rows.set(key, carried);
  }
}

function carriersOf(value: InstanceValue): Carriers {
  const configuration = value.publisherConfiguration;
  const carriers = new CarriersRead(configuration.kind === 'read' ? configuration.covering : () => []);
  const carriedByMod = new Map<string, Set<PublisherTag>>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod') continue;
    const folders = value.foldersByMod.get(entry.name) ?? [];
    const filesBeneath = carriers.carryFilesAndFolders(
      modOrigin(entry.name), entry.name, [...(value.filesByMod.get(entry.name) ?? []), ...folders], folders,
    );
    const folder = value.paths.modDirs.get(entry.name);
    const own = folder === undefined ? [] : carriers.covering(folder, entry.name);
    carriedByMod.set(entry.name, carriers.carryOpenableRow(modRowUri(entry.name).toString(), own, filesBeneath));
  }
  const overwriteBeneath = carriers.carryFilesAndFolders(
    RUNTIME_OUTPUT, undefined, [...value.overwriteFiles, ...value.overwriteFolders], value.overwriteFolders,
  );
  carriers.carryOpenableRow(overwriteRowUri().toString(), [], overwriteBeneath);
  for (const { separator, mods } of value.modGroups.groups) {
    const beneath = mods.flatMap(({ name }) => [...(carriedByMod.get(name) ?? [])]);
    carriers.carryOpenableRow(separatorRowUri(separator.name).toString(), [], beneath);
  }
  return carriers;
}

/** One provider for each publisher tag the publisher declares. */
export class PublisherTagDecorations extends OpenableRowDecorations<Carriers> {
  readonly providers: readonly IndicatorDecorationProvider[];

  constructor(instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings) {
    super(instance, carriersOf, (carriers, key) => carriers.openable.has(key));
    const carries = (tag: PublisherTag) => (uri: vscode.Uri): boolean => {
      const key = uri.toString();
      const carried = this.carriers().rows.get(key);
      return carried !== undefined && (carried.own.has(tag) || (!this.isOpen(key) && carried.beneath.has(tag)));
    };
    this.providers = instance.value.publisherTags.map((tag) => new IndicatorDecorationProvider(
      { id: PUBLISHER_TAG_INDICATOR.id, name: tag.name, badge: tag.badge, colour: PUBLISHER_TAG_INDICATOR.colour }, carries(tag), settings, isModRow,
    ));
  }
}
