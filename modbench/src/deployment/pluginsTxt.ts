// The plugins.txt the game reads, written inside the all-or-nothing deploy (deployment-hardlink.md, plugins.txt).
// A file there that deploy did not write is renamed, never replaced; one it wrote is replaced.

import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { errorMessage } from '../ports/errorMessage';
import { PLUGINS_FILE_NAME } from '../loadOrderFileCodec/pluginsText';
import { fileIdAt, removeFolders, type Step } from './changes';
import type { WrittenPluginsTxt } from './record';

const RENAMED = '.modbench_renamed';
const REPLACED = '.modbench_replaced';

export interface WritePluginsTxt {
  readonly kind: 'write';
  readonly step: Step;
  /** What the step wrote, once it has. */
  written(): WrittenPluginsTxt;
  /** The name the step renamed a file to, once it has. */
  renamedTo(): string | undefined;
  /** Removes what the step kept to undo itself, and answers each file it could not remove. */
  settle(): Promise<string[]>;
}

export type PluginsTxtChange = { readonly kind: 'unchanged' } | WritePluginsTxt;

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

function writing(folder: string, text: string, owned: boolean, previous: WrittenPluginsTxt | undefined): WritePluginsTxt {
  const path = join(folder, PLUGINS_FILE_NAME);
  let kept: string | undefined;
  let renamed: string | undefined;
  let ino = '';
  const step: Step = async () => {
    const created = await mkdir(folder, { recursive: true });
    const temp = `${path}.modbench_new_${process.pid}`;
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
    async settle() {
      if (!owned || kept === undefined) return [];
      try {
        await unlink(kept);
        return [];
      } catch (err) {
        return [`${kept} (${errorMessage(err)})`];
      }
    },
  };
}

/** What writing `text` as the plugins.txt in `folder` changes, given what deploy last wrote. */
export async function pluginsTxtChange(folder: string, text: string, previous: WrittenPluginsTxt | undefined): Promise<PluginsTxtChange> {
  const path = join(folder, PLUGINS_FILE_NAME);
  const present = await fileIdAt(path);
  const ours = previous?.path === path ? previous : undefined;
  const owned = present !== undefined && ours?.ino === present;
  if (owned && await readFile(path, 'utf8') === text) return { kind: 'unchanged' };
  return writing(folder, text, owned, ours);
}
