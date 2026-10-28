import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { ASIDE, fileIdAt, linkedFree, moved, namesIn, removeFolders, removedAll, setAside, unlinkedIfThere, type Step } from './changes';
import type { WrittenPluginsTxt } from './record';

const RENAMED = '.modbench_renamed';
const NEW = '.modbench_new_';
// The game reads a `#` line as a comment. The mark is the one evidence of a deploy's file that holds across instances and
// deployment folders, as the plugins.txt the game reads is shared and no record is.
const MARK = '# Written by Modbench deploy.\r\n';

export interface PluginsTxtChange {
  /** Absent when the file already holds the text. */
  readonly step: Step | undefined;
  /** Whether the record holds something other than what deploy last recorded. */
  readonly recordChanged: boolean;
  /** What the record holds once the deploy lands. */
  written(): WrittenPluginsTxt | undefined;
  /** The files deploy renamed or, killed, had renamed and never recorded; once the step has run. */
  renamed(): string[];
  /** Removes what the deploy kept to undo itself, and what a killed deploy left. */
  settle(): Promise<string[]>;
}

interface Backup {
  readonly nameAt: (n: number) => string;
  readonly isTheUsers: boolean;
}

const renamedAt = (path: string) => (n: number): string => (n === 0 ? path + RENAMED : `${path}${RENAMED}_${n + 1}`);
const asideAt = (path: string) => (n: number): string => `${path}${ASIDE}${process.pid}_${n}`;

interface Writing {
  readonly step: Step;
  readonly fileId: () => string;
  readonly renamedNow: () => string | undefined;
  readonly settle: () => Promise<string[]>;
}

function writing(folder: string, text: string, backup: Backup, stale: readonly string[]): Writing {
  const path = join(folder, PLUGINS_FILE_NAME);
  let kept: string | undefined;
  let fileId = '';
  const step: Step = async () => {
    const created = await mkdir(folder, { recursive: true });
    const temp = `${path}${NEW}${process.pid}`;
    let placed = false;
    const restore = async (): Promise<void> => {
      await unlinkedIfThere(temp);
      if (!placed) {
        if (kept !== undefined) await unlink(kept);
      } else if (kept === undefined) await unlinkedIfThere(path);
      else await rename(kept, path);
      if (created !== undefined) await removeFolders(folder, created);
    };
    try {
      await writeFile(temp, text);
      if (await fileIdAt(path) !== undefined) kept = await linkedFree(path, backup.nameAt);
      await rename(temp, path);
      placed = true;
      fileId = (await fileIdAt(path)) ?? '';
    } catch (err) {
      try {
        await restore();
      } catch (undoErr) {
        throw new Error(`${errorMessage(err)}. Deploy could not undo writing ${path}: ${errorMessage(undoErr)}`);
      }
      throw err;
    }
    return { left: `${path}, which deploy wrote`, run: restore };
  };
  return {
    step,
    fileId: () => fileId,
    renamedNow: () => (backup.isTheUsers ? kept : undefined),
    settle: () => removedAll(backup.isTheUsers || kept === undefined ? stale : [...stale, kept]),
  };
}

interface Leftovers {
  readonly stale: string[];
  /** Files a killed deploy renamed and never recorded. */
  readonly recovered: string[];
  /** A file deploy set aside carries the recorded file ID, so the file in place is one a killed deploy wrote and never recorded. */
  readonly placedUnrecorded: boolean;
}

// A renamed file the record does not name is recorded and reported, and proves nothing about the file in place: the record is
// per deployment folder and plugins.txt is shared.
async function leftoversOf(folder: string, present: string | undefined, previous: WrittenPluginsTxt | undefined): Promise<Leftovers> {
  const stale: string[] = [];
  const recovered: string[] = [];
  let placedUnrecorded = false;
  for (const name of (await namesIn(folder)).sort()) {
    const at = join(folder, name);
    if (name.startsWith(PLUGINS_FILE_NAME + NEW)) stale.push(at);
    else if (name.startsWith(PLUGINS_FILE_NAME + ASIDE)) {
      stale.push(at);
      if (present !== undefined && previous !== undefined && present !== previous.fileId && await fileIdAt(at) === previous.fileId) placedUnrecorded = true;
    } else if (name.startsWith(PLUGINS_FILE_NAME + RENAMED) && !previous?.renamed.includes(at)) recovered.push(at);
  }
  return { stale, recovered, placedUnrecorded };
}

/** What writing `order` as the plugins.txt in `folder` changes, given what deploy last wrote. A marked file is deploy's, from any
 *  instance; a file that already holds the order is left. */
export async function pluginsTxtChange(folder: string, order: string, previous: WrittenPluginsTxt | undefined): Promise<PluginsTxtChange> {
  const path = join(folder, PLUGINS_FILE_NAME);
  const text = MARK + order;
  const present = await fileIdAt(path);
  const held = present === undefined ? undefined : await readFile(path, 'utf8');
  const marked = held?.startsWith(MARK) === true;
  const ours = previous?.path === path ? previous : undefined;
  const { stale, recovered, placedUnrecorded } = await leftoversOf(folder, present, ours);
  const isDeploys = present !== undefined && (marked || ours?.fileId === present || placedUnrecorded);
  const recordedAs = (fileId: string, renamedNow: string[]): WrittenPluginsTxt => ({
    path, fileId, renamed: [...new Set([...(ours?.renamed ?? []), ...recovered, ...renamedNow])],
  });
  if (held !== undefined && (marked ? held.slice(MARK.length) : held) === order) {
    const recordChanged = (isDeploys && ours?.fileId !== present) || recovered.length > 0;
    const written = (): WrittenPluginsTxt | undefined => (recordChanged ? recordedAs(isDeploys ? present : (ours?.fileId ?? ''), []) : ours);
    return { step: undefined, recordChanged, written, renamed: () => recovered, settle: () => removedAll(stale) };
  }
  const write = writing(folder, text, isDeploys ? { nameAt: asideAt(path), isTheUsers: false } : { nameAt: renamedAt(path), isTheUsers: true }, stale);
  const renamedNow = (): string[] => {
    const name = write.renamedNow();
    return name === undefined ? [] : [name];
  };
  return {
    step: write.step,
    recordChanged: true,
    written: () => recordedAs(write.fileId(), renamedNow()),
    renamed: () => [...recovered, ...renamedNow()],
    settle: write.settle,
  };
}

export interface PluginsTxtPurge {
  /** Absent when purge changes nothing there. */
  readonly step: Step | undefined;
  /** The file the step puts back. */
  readonly restored: string | undefined;
  /** Each file deploy renamed that is still there and that purge leaves. */
  readonly left: readonly string[];
  /** Removes the file the step set aside and what a killed deploy left; once the purge has landed. */
  settle(): Promise<string[]>;
}

// A plugins.txt that is not deploy's stays, with each file deploy renamed (ADR-0003).
export async function pluginsTxtPurge(previous: WrittenPluginsTxt): Promise<PluginsTxtPurge> {
  const path = previous.path;
  const present = await fileIdAt(path);
  const marked = present !== undefined && (await readFile(path, 'utf8')).startsWith(MARK);
  const { stale, recovered, placedUnrecorded } = await leftoversOf(dirname(path), present, previous);
  const isDeploys = present !== undefined && (marked || previous.fileId === present || placedUnrecorded);
  const there: string[] = [];
  for (const name of new Set([...previous.renamed, ...recovered])) if (await fileIdAt(name) !== undefined) there.push(name);
  const back = present === undefined || isDeploys ? there.at(-1) : undefined;
  let aside: string | undefined;
  const step: Step = async () => {
    if (isDeploys) aside = await setAside(path);
    try {
      if (back !== undefined) await moved(back, path);
    } catch (err) {
      if (aside !== undefined) {
        try {
          await moved(aside, path);
        } catch (undoErr) {
          throw new Error(`${errorMessage(err)}. Purge could not put back ${path}, which it left as ${aside}: ${errorMessage(undoErr)}`);
        }
      }
      throw err;
    }
    return {
      left: `${path}, which purge removed`,
      run: async () => {
        if (back !== undefined) await moved(path, back);
        if (aside !== undefined) await moved(aside, path);
      },
    };
  };
  return {
    step: isDeploys || back !== undefined ? step : undefined,
    restored: back,
    left: there.filter((name) => name !== back),
    settle: () => removedAll(aside === undefined ? stale : [...stale, aside]),
  };
}
