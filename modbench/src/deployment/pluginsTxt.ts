import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import { PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { ASIDE, fileIdAt, linkedFree, namesIn, removeFolders, removedAll, unlinkedIfThere, type Step } from './changes';
import type { WrittenPluginsTxt } from './record';

const RENAMED = '.modbench_renamed';
const NEW = '.modbench_new_';

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
  readonly ino: () => string;
  readonly renamedNow: () => string | undefined;
  readonly settle: () => Promise<string[]>;
}

function writing(folder: string, text: string, backup: Backup, stale: readonly string[]): Writing {
  const path = join(folder, PLUGINS_FILE_NAME);
  let kept: string | undefined;
  let ino = '';
  const step: Step = async () => {
    const created = await mkdir(folder, { recursive: true });
    const temp = path + NEW + process.pid;
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
      ino = (await fileIdAt(path)) ?? '';
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
    ino: () => ino,
    renamedNow: () => (backup.isTheUsers ? kept : undefined),
    settle: () => removedAll(backup.isTheUsers || kept === undefined ? stale : [...stale, kept]),
  };
}

interface Leftovers {
  readonly stale: string[];
  /** Files a killed deploy renamed and never recorded. */
  readonly recovered: string[];
  /** The file in place is one a killed deploy wrote and never recorded. */
  readonly placedUnrecorded: boolean;
}

// A deploy killed after it renamed or set aside the file in place leaves that file, which the record does not name.
async function leftoversOf(folder: string, present: string | undefined, previous: WrittenPluginsTxt | undefined): Promise<Leftovers> {
  const stale: string[] = [];
  const recovered: string[] = [];
  let placedUnrecorded = false;
  for (const name of (await namesIn(folder)).sort()) {
    const at = join(folder, name);
    if (name.startsWith(PLUGINS_FILE_NAME + NEW)) stale.push(at);
    else if (name.startsWith(PLUGINS_FILE_NAME + ASIDE)) {
      stale.push(at);
      if (present !== undefined && previous !== undefined && present !== previous.ino && await fileIdAt(at) === previous.ino) placedUnrecorded = true;
    } else if (name.startsWith(PLUGINS_FILE_NAME + RENAMED) && !previous?.renamed.includes(at)) recovered.push(at);
  }
  return { stale, recovered, placedUnrecorded: placedUnrecorded || recovered.length > 0 };
}

/** What writing `text` as the plugins.txt in `folder` changes, given what deploy last wrote. A file that already holds
 *  the text is left, whoever wrote it, as no order is lost. */
export async function pluginsTxtChange(folder: string, text: string, previous: WrittenPluginsTxt | undefined): Promise<PluginsTxtChange> {
  const path = join(folder, PLUGINS_FILE_NAME);
  const present = await fileIdAt(path);
  const ours = previous?.path === path ? previous : undefined;
  const { stale, recovered, placedUnrecorded } = await leftoversOf(folder, present, ours);
  const isDeploys = present !== undefined && (ours?.ino === present || placedUnrecorded);
  const recordedAs = (ino: string, renamedNow: string[]): WrittenPluginsTxt => ({ path, ino, renamed: [...(ours?.renamed ?? []), ...recovered, ...renamedNow] });
  if (present !== undefined && await readFile(path, 'utf8') === text) {
    const recordChanged = isDeploys && (ours?.ino !== present || recovered.length > 0);
    return { step: undefined, recordChanged, written: () => (recordChanged ? recordedAs(present, []) : ours), renamed: () => recovered, settle: () => removedAll(stale) };
  }
  const write = writing(folder, text, isDeploys ? { nameAt: asideAt(path), isTheUsers: false } : { nameAt: renamedAt(path), isTheUsers: true }, stale);
  const renamedNow = (): string[] => {
    const name = write.renamedNow();
    return name === undefined ? [] : [name];
  };
  return {
    step: write.step,
    recordChanged: true,
    written: () => recordedAs(write.ino(), renamedNow()),
    renamed: () => [...recovered, ...renamedNow()],
    settle: write.settle,
  };
}
