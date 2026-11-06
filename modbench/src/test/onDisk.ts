import { rename, rm, writeFile } from 'node:fs/promises';
import type { RenameEditing } from '../coreLib/change';
import { heldTexts } from '../symbolNames/symbolNames';

/** A rename's edit written straight to the disk, as VS Code's workspace edit lands it, with no unsaved text. */
export const onDisk: RenameEditing = {
  held: heldTexts([]),
  apply: async (changes) => {
    for (const { moves, deletions, documents } of changes) {
      for (const { from, to } of moves) await rename(from, to);
      for (const path of deletions) await rm(path, { recursive: true, force: true });
      for (const { path, text } of documents) await writeFile(path, text);
    }
    return undefined;
  },
};
