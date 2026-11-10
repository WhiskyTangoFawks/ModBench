// mods.md, The tree, story 13: what each archive in a mod or Overwrite holds, as mEdit reads it (ADR-0016).

import type { MEditClient } from '../client/MEditClient';
import type { FileRead, FileStamp, OriginFile } from '../instanceAdapter/instanceAdapter';
import { pluginCompanionRule } from '../tables/gamePaths';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { foldPath } from './fileConflictIndex';

/** An archive's files, by their forward-slash paths in it, or why it cannot be read. */
export type ArchiveRead = FileRead<readonly string[]>;

export type ArchiveReader = Pick<MEditClient, 'getArchiveContents' | 'onStatusChanged'>;

const stampKey = ({ size, modifiedNs }: FileStamp): string => `${size}/${modifiedNs}`;

/** Each archive at the root of `files`, by the path it is read from. */
export function archivePathsIn(gameRelease: string, files: readonly OriginFile[]): string[] {
  const rule = pluginCompanionRule(gameRelease);
  return rule === undefined ? [] : files.filter((file) => rule.isArchive(file.relativePath)).map((file) => file.sourcePath);
}

/** Keeps what mEdit answered for each archive with the stamp it had, so an archive is asked again only once its stamp
 *  changes. An archive mEdit gave no answer for is asked again at the next read. */
export class ArchiveContentsHeld {
  private held = new Map<string, { readonly stamp: string; readonly read: ArchiveRead }>();
  private unanswered = false;

  constructor(private readonly reader: ArchiveReader, private readonly stampOf: (path: string) => Promise<FileRead<FileStamp>>) {}

  /** Whether the last read left an archive that mEdit gave no answer for. */
  get anyUnanswered(): boolean {
    return this.unanswered;
  }

  async read(gameRelease: string, archives: readonly string[]): Promise<ReadonlyMap<string, ArchiveRead>> {
    const stamps = await Promise.all(archives.map(async (path) => ({ path, stamp: await this.stampOf(path) })));
    const changed = stamps.flatMap(({ path, stamp }) =>
      (stamp.kind === 'read' && this.held.get(path)?.stamp !== stampKey(stamp.answer) ? [path] : []));
    const answered = changed.length === 0 ? [] : await this.reader.getArchiveContents(gameRelease, changed);
    const noAnswer: ArchiveRead = { kind: 'unreadable', reason: isReadFailed(answered) ? failureReason(answered) : 'mEdit gave no answer for it.' };
    const answers = new Map(isReadFailed(answered) ? [] : answered.map(({ archive, files, unreadable }): [string, ArchiveRead] => [
      archive, typeof unreadable === 'string' ? { kind: 'unreadable', reason: unreadable } : { kind: 'read', answer: files },
    ]));
    const held = new Map<string, { readonly stamp: string; readonly read: ArchiveRead }>();
    const reads = new Map(stamps.map(({ path, stamp }): [string, ArchiveRead] => {
      if (stamp.kind === 'unreadable') return [path, stamp];
      const key = stampKey(stamp.answer);
      const kept = this.held.get(path);
      const read = answers.get(path) ?? (kept?.stamp === key ? kept.read : undefined);
      if (read === undefined) return [path, noAnswer];
      held.set(path, { stamp: key, read });
      return [path, read];
    }));
    this.held = held;
    this.unanswered = [...reads.values()].includes(noAnswer);
    return reads;
  }
}

/** Whether the game loads an archive at the root of its Data folder, by its name: the INIs list it, or it is named for
 *  a plugin the game loads. */
export function archivesTheGameLoads(gameRelease: string, listed: readonly string[], loaded: readonly string[]): (name: string) => boolean {
  const rule = pluginCompanionRule(gameRelease);
  const listedNames = new Set(listed.map(foldPath));
  return (name) => listedNames.has(foldPath(name)) || (rule !== undefined && loaded.some((plugin) => rule.isArchiveOf(plugin, name)));
}
