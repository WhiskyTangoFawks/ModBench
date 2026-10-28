// The plugins.txt the game reads, written inside the all-or-nothing deploy (deployment-hardlink.md, plugins.txt).
// A file there that deploy did not write is renamed, never replaced; one it wrote is replaced.

import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { fileIdAt, removeFolders, type Step } from './changes';
import type { WrittenPluginsTxt } from './record';

const RENAMED = '.modbench_renamed';
const REPLACED = '.modbench_replaced';
const NEW = '.modbench_new_';

interface Settles {
  /** Removes what the deploy kept to undo itself, and answers each file it could not remove. */
  settle(): Promise<string[]>;
}

export interface UnchangedPluginsTxt extends Settles {
  readonly kind: 'unchanged';
  /** The file a killed deploy wrote and never recorded, which is deploy's. */
  readonly adopted?: WrittenPluginsTxt;
}

export interface WritePluginsTxt extends Settles {
  readonly kind: 'write';
  readonly step: Step;
  /** What the step wrote, once it has. */
  written(): WrittenPluginsTxt;
  /** The name the step renamed a file to, once it has. */
  renamedTo(): string | undefined;
}

export type PluginsTxtChange = UnchangedPluginsTxt | WritePluginsTxt;

const renamedName = (path: string, n: number): string => (n === 1 ? path + RENAMED : `${path}${RENAMED}_${n}`);

async function linkedFree(from: string, name: (n: number) => string): Promise<string> {
  for (let n = 1; ; n++) {
    const to = name(n);
    try {
      await link(from, to);
      return to;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
}

const unlinkedIfThere = (path: string): Promise<void> =>
  unlink(path).catch((err: unknown) => {
    if (errnoCode(err) !== 'ENOENT') throw err;
  });

function writing(folder: string, text: string, owned: boolean, previous: WrittenPluginsTxt | undefined, stale: readonly string[]): WritePluginsTxt {
  const path = join(folder, PLUGINS_FILE_NAME);
  let kept: string | undefined;
  let renamed: string | undefined;
  let ino = '';
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
      if (await fileIdAt(path) !== undefined) {
        kept = await linkedFree(path, (n) => (owned ? `${path}${REPLACED}_${n}` : renamedName(path, n)));
        if (!owned) renamed = kept;
      }
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
  const renamedTo = previous?.renamedTo;
  return {
    kind: 'write',
    step,
    written: () => ({ path, ino, ...((renamed ?? renamedTo) === undefined ? {} : { renamedTo: renamed ?? renamedTo }) }),
    renamedTo: () => renamed,
    settle: () => removed(owned && kept !== undefined ? [...stale, kept] : stale),
  };
}

async function removed(paths: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const path of paths) {
    try {
      await unlinkedIfThere(path);
    } catch (err) {
      left.push(`${path} (${errorMessage(err)})`);
    }
  }
  return left;
}

// A killed deploy leaves its temp file, and the file it replaced; the replaced file is the recorded one
// only when the kill came after the new file was placed, so the file in place is deploy's though unrecorded.
async function leftoversOf(folder: string, present: string | undefined, previous: WrittenPluginsTxt | undefined): Promise<{ stale: string[]; placedUnrecorded: boolean }> {
  const names = await readdir(folder).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  });
  const stale: string[] = [];
  let placedUnrecorded = false;
  for (const name of names) {
    const at = join(folder, name);
    if (name.startsWith(PLUGINS_FILE_NAME + NEW)) stale.push(at);
    else if (name.startsWith(`${PLUGINS_FILE_NAME}${REPLACED}_`)) {
      stale.push(at);
      if (present !== undefined && previous !== undefined && await fileIdAt(at) === previous.ino && present !== previous.ino) placedUnrecorded = true;
    }
  }
  return { stale, placedUnrecorded };
}

/** What writing `text` as the plugins.txt in `folder` changes, given what deploy last wrote. A file that already holds
 *  the text is left, whoever wrote it, as no order is lost. */
export async function pluginsTxtChange(folder: string, text: string, previous: WrittenPluginsTxt | undefined): Promise<PluginsTxtChange> {
  const path = join(folder, PLUGINS_FILE_NAME);
  const present = await fileIdAt(path);
  const ours = previous?.path === path ? previous : undefined;
  const { stale, placedUnrecorded } = await leftoversOf(folder, present, ours);
  const owned = present !== undefined && (ours?.ino === present || placedUnrecorded);
  if (present !== undefined && await readFile(path, 'utf8') === text) {
    const adopted = placedUnrecorded && ours?.ino !== present ? { ...ours, path, ino: present } : undefined;
    return { kind: 'unchanged', ...(adopted === undefined ? {} : { adopted }), settle: () => removed(stale) };
  }
  return writing(folder, text, owned, ours, stale);
}
