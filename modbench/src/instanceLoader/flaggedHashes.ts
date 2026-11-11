// instance-repository.md, Status, story 8: what a plugin its manifest flags could have held before the flags, as mEdit says it (ADR-0013).

import type { MEditClient } from '../client/MEditClient';
import type { FileRead, FileStamp, InstanceAdapter, OriginFile } from '../instanceAdapter/instanceAdapter';
import { manifestAt, type FlaggedRead } from '../manifestAdapter/manifestAdapter';
import type { FlaggedPluginFile } from '../wire/messages';
import { isReadFailed } from '../wire/readFailed';

export type FlaggedReader = Pick<MEditClient, 'getFlaggedPluginHashes' | 'onStatusChanged'>;

const UNANSWERED: FlaggedRead = { kind: 'unanswered' };

const keyOf = ({ size, modifiedNs }: FileStamp, flags: FlaggedPluginFile['flags']): string =>
  `${size}/${modifiedNs}/${JSON.stringify(Object.entries(flags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;

/** Each plugin file a mod's manifest flags, by the path it is read from, with the flags. */
export async function flaggedPluginsIn(
  mods: readonly { readonly folder: string; readonly files: readonly Pick<OriginFile, 'relativePath' | 'sourcePath'>[] }[], ownPath: InstanceAdapter['ownPath'],
): Promise<FlaggedPluginFile[]> {
  const flagged: FlaggedPluginFile[] = [];
  for (const { folder, files } of mods) {
    const { read } = await manifestAt(folder);
    if (read === undefined || !('manifest' in read)) continue;
    const flagsOf = new Map([...read.manifest.flags].map(([path, flags]) => [path.toLowerCase(), flags]));
    for (const { relativePath, sourcePath } of files) {
      const flags = flagsOf.get(ownPath(relativePath).toLowerCase());
      if (flags !== undefined) flagged.push({ path: sourcePath, flags });
    }
  }
  return flagged;
}

/** Keeps what mEdit answered for each plugin file with its stamp and the flags asked, so a file is asked again only once
 *  either changes, or while no answer came or mEdit could not read it. */
export class FlaggedHashesHeld {
  private held = new Map<string, { readonly key: string; readonly read: Extract<FlaggedRead, { readonly kind: 'read' }> }>();
  private unanswered = false;

  constructor(private readonly reader: Pick<MEditClient, 'getFlaggedPluginHashes'>, private readonly stampOf: (path: string) => Promise<FileRead<FileStamp>>) {}

  get anyUnanswered(): boolean {
    return this.unanswered;
  }

  async read(gameRelease: string, files: readonly FlaggedPluginFile[]): Promise<ReadonlyMap<string, FlaggedRead>> {
    const keyed = await Promise.all(files.map(async (file) => {
      const stamp = await this.stampOf(file.path);
      return { file, stamp, key: stamp.kind === 'read' ? keyOf(stamp.answer, file.flags) : undefined };
    }));
    const changed = keyed.flatMap(({ file, key }) => (key !== undefined && this.held.get(file.path)?.key !== key ? [file] : []));
    const answered = changed.length === 0 ? [] : await this.reader.getFlaggedPluginHashes(gameRelease, changed);
    const answers = new Map(isReadFailed(answered) ? [] : answered.map(({ path, hashes, unreadable }): [string, FlaggedRead] => [path, typeof unreadable === 'string' ? { kind: 'unreadable', reason: unreadable } : { kind: 'read', answer: hashes }]));
    const held = new Map<string, { readonly key: string; readonly read: Extract<FlaggedRead, { readonly kind: 'read' }> }>();
    const reads = new Map(keyed.map(({ file, stamp, key }): [string, FlaggedRead] => {
      if (stamp.kind === 'unreadable') return [file.path, stamp];
      const kept = this.held.get(file.path);
      const read = answers.get(file.path) ?? (kept !== undefined && kept.key === key ? kept.read : undefined);
      if (read === undefined || key === undefined) return [file.path, UNANSWERED];
      if (read.kind === 'read') held.set(file.path, { key, read });
      return [file.path, read];
    }));
    this.held = held;
    this.unanswered = [...reads.values()].includes(UNANSWERED);
    return reads;
  }
}
