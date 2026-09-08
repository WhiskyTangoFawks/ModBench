// modlist.txt gesture commands (ADR-0047 point 6): a free function per gesture, taking the
// instance root, the profile and its own inputs, returning applied or a refusal. No class,
// no interface, no base type.

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteSeparatorInText,
  insertModAtWinningEnd,
  insertSeparatorAtIndexInText,
  moveModInText,
  moveModToSeparatorEndInText,
  moveSeparatorBlockInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  setEnabledInText,
} from './modlistText';
import { setUninstalledInText } from './downloads';
import { parseMetaIni } from './metaIni';

/** A refusal is an outcome, not an exception (mirrors `RecordEditOutcome` in
 *  `PluginRepository.ts`). `refusal` names what was refused; `message` is displayable as-is. */
export type ModlistCommandOutcome =
  | { applied: true }
  | { applied: false; refusal: string; message: string };

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const modlistPath = (instanceRoot: string, profile: string): string =>
  join(instanceRoot, 'profiles', profile, 'modlist.txt');

const outcomeMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The one queue every modlist.txt write for an instance passes through — module-private
// infrastructure, not an abstraction over commands. Keyed by instance root, so every profile
// under it serializes together. Exported so Mo2ModlistSource's own writes share it too.
const modlistWriteQueues = new Map<string, Promise<unknown>>();

export function withModlistWriteLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = modlistWriteQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  // The chain tail must never stay rejected, or every later write on this instance queues
  // behind a dead link forever — only the caller's own `next` sees the error.
  modlistWriteQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

// The one splice point every verb below goes through. A transform that throws (the kernel's
// "not found" signal) becomes `refusal` rather than an exception escaping the command.
function spliceModlist(
  instanceRoot: string,
  profile: string,
  refusal: string,
  transform: (text: string) => string,
): Promise<ModlistCommandOutcome> {
  return withModlistWriteLock(instanceRoot, async () => {
    const path = modlistPath(instanceRoot, profile);
    try {
      const text = await readFile(path, 'utf8');
      await writeFile(path, transform(text));
      return { applied: true };
    } catch (err) {
      return { applied: false, refusal, message: outcomeMessage(err) };
    }
  });
}

/** Flip a mod's `+`/`-` prefix — the Mods tree checkbox. */
export function setModEnabled(
  instanceRoot: string, profile: string, modName: string, enabled: boolean,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'ModNotFound', (text) => setEnabledInText(text, modName, enabled));
}

/** Move a mod to `toIndex` among entry lines (drag-reorder). */
export function reorderMod(
  instanceRoot: string, profile: string, modName: string, toIndex: number,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'ModNotFound', (text) => moveModInText(text, modName, toIndex));
}

/** Insert a new enabled separator after `afterEntryName`; when that entry is itself a
 *  separator, inserts after its last member. */
export function insertSeparator(
  instanceRoot: string, profile: string, name: string, afterEntryName: string,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'EntryNotFound', (text) => {
    const entries = parseModlist(text);
    const entryIdx = entries.findIndex((e) => e.name === afterEntryName);
    if (entryIdx === -1) throw new Error(`Entry not found in modlist: ${afterEntryName}`);
    let afterIndex = entryIdx;
    if (entries[entryIdx].kind === 'separator') {
      for (let i = entryIdx + 1; i < entries.length; i++) {
        if (entries[i].kind === 'separator') break;
        afterIndex = i;
      }
    }
    return insertSeparatorAtIndexInText(text, name, afterIndex);
  });
}

/** Rename a separator in place. */
export function renameSeparator(
  instanceRoot: string, profile: string, oldName: string, newName: string,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'SeparatorNotFound', (text) => renameSeparatorInText(text, oldName, newName));
}

/** Remove a separator's own line; the mods it wrapped join the section above. */
export function deleteSeparator(instanceRoot: string, profile: string, name: string): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'SeparatorNotFound', (text) => deleteSeparatorInText(text, name));
}

/** Move a mod to the end of `separatorName`'s section, or the ungrouped tail when null. */
export function moveModToSeparator(
  instanceRoot: string, profile: string, modName: string, separatorName: string | null,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'ModNotFound', (text) => moveModToSeparatorEndInText(text, modName, separatorName));
}

/** Move a separator and every mod it wraps, as one block, to entry-index `toIndex`. */
export function reorderSeparatorBlock(
  instanceRoot: string, profile: string, separatorName: string, toIndex: number,
): Promise<ModlistCommandOutcome> {
  return spliceModlist(instanceRoot, profile, 'SeparatorNotFound', (text) => moveSeparatorBlockInText(text, separatorName, toIndex));
}

// Best-effort: a download never installed from, or whose .meta is already gone, is normal.
async function markDownloadUninstalled(instanceRoot: string, modName: string): Promise<void> {
  let archiveFilename: string | undefined;
  try {
    const metaIniText = await readFile(join(instanceRoot, 'mods', modName, 'meta.ini'), 'utf8');
    archiveFilename = parseMetaIni(metaIniText).archiveFilename;
  } catch {
    return;
  }
  if (!archiveFilename) return;
  const downloadPath = join(instanceRoot, 'downloads', archiveFilename);
  if (!(await exists(downloadPath))) return;
  const metaPath = `${downloadPath}.meta`;
  try {
    let metaText: string;
    try {
      metaText = await readFile(metaPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') metaText = '';
      else throw err;
    }
    await writeFile(metaPath, setUninstalledInText(metaText));
  } catch {
    // Bookkeeping only — never blocks the uninstall itself.
  }
}

/** Removes the modlist.txt entry and the `mods/<name>/` folder. Refuses only when the modlist
 *  has no entry for `modName`; a folder-delete failure afterwards leaves a recoverable orphan. */
export async function uninstallMod(instanceRoot: string, profile: string, modName: string): Promise<ModlistCommandOutcome> {
  // Reads installationFile first: deleting the folder destroys the link to the source download.
  await markDownloadUninstalled(instanceRoot, modName);
  // De-list before deleting: a failed delete leaves a recoverable orphan, not a dangling entry.
  const outcome = await spliceModlist(instanceRoot, profile, 'ModNotFound', (text) => removeModFromText(text, modName));
  if (!outcome.applied) return outcome;
  await rm(join(instanceRoot, 'mods', modName), { recursive: true, force: true }).catch(() => undefined);
  return outcome;
}

/** A folder under `mods/` plus a disabled modlist.txt line — nothing else. Refuses when `name`
 *  is already a mod folder on disk. */
export async function createEmptyMod(instanceRoot: string, profile: string, name: string): Promise<ModlistCommandOutcome> {
  const modDir = join(instanceRoot, 'mods', name);
  if (await exists(modDir)) {
    return { applied: false, refusal: 'ModAlreadyExists', message: `A mod named "${name}" already exists.` };
  }
  await mkdir(modDir, { recursive: true });
  return spliceModlist(instanceRoot, profile, 'WriteFailed', (text) => insertModAtWinningEnd(text, name));
}
