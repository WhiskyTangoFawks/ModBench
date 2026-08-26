// Assembles the ordered { name, path, origin, participates } list for the backend's
// `load-explicit` session (POST /session/load-explicit) from the active profile's
// plugins.txt — every line, enabled and disabled alike (#270 / ADR-0035). Plugin
// *order* comes from plugins.txt; each name resolves to its winning physical path
// via the MO2-priority FileConflictIndex, falling back to the game's Data folder for
// a base-game plugin no mod provides. Vanilla masters are NOT listed here — the backend
// prepends them from the game directory, forced on and immutable, ahead of this list.
// Creation Club content cataloged in the game's own [Game].ccc gets the same forced
// treatment (#434), also prepended server-side — this module never reads that catalog.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IModlistSource } from './model';
import { buildFileConflictIndex, foldPath, rootLevelWinnerMods, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';

// Reserved origin values (#269 / ADR-0036): the game's Data directory, and MO2's overwrite
// folder — matching their literal directory names. Never a real mod folder name: mod folders live
// under a different namespace (`mods/`), and "overwrite" is already a reserved MO2 folder name
// elsewhere in this codebase (modlistText.ts's RESERVED_DIR_NAMES).
export const DATA_DIRECTORY_ORIGIN = 'Data';
export const OVERWRITE_ORIGIN = 'overwrite';

export interface ExplicitPlugin {
  name: string;
  path: string;
  /** The mod folder that provided this plugin, or a reserved origin value above (#269 / ADR-0036). */
  origin: string;
  /** The plugins.txt `*` prefix: whether this plugin loads in the game and so competes for winner
   *  (#270 / ADR-0035). A non-participating plugin is still indexed and fully browsable — it just
   *  can never win a FormKey or take part in conflict classification. */
  participates: boolean;
}

/** Resolve each plugin name to its winning physical path: the MO2-priority
 *  FileConflictIndex winner for a mod-provided plugin, else the game's Data
 *  folder for a base-game/DLC/CC plugin no mod provides. Keyed by lowercased
 *  name (plugins.txt casing is not authoritative). Only root-level index files
 *  are considered — a nested file sharing a plugin's basename must not shadow
 *  the real plugin. Shared by the editing-session builder and the Plugin List's
 *  order-aware missing-master check. */
export function resolvePluginPaths(
  names: string[],
  index: FileConflictIndex,
  dataFolder: string,
): Map<string, string> {
  const winnerByName = rootLevelWinners(index);
  return new Map(names.map((name) => [name, winnerByName.get(name.toLowerCase()) ?? join(dataFolder, name)]));
}

/** Root-level files directly under the instance's overwrite/ folder, keyed by case-folded name to
 *  their real on-disk name (#269 / ADR-0036). MO2's VFS gives overwrite/ the highest priority of
 *  all — above every mod and the Data folder — so a plugin found here always wins path resolution
 *  too, not just origin classification. Root-level only, mirroring rootLevelWinners' own reasoning:
 *  a nested file sharing a plugin's basename must not shadow the real plugin. Empty when the
 *  overwrite folder doesn't exist yet — it isn't created until the first purge deposits a stray
 *  file (overwriteFolder.ts). */
async function overwritePluginFiles(instanceRoot: string): Promise<Map<string, string>> {
  try {
    const entries = await readdir(join(instanceRoot, 'overwrite'), { withFileTypes: true });
    return new Map(entries.filter((e) => e.isFile()).map((e) => [foldPath(e.name), e.name]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); // no overwrite folder — nothing wins from it
    throw err;
  }
}

/** Where a plugin name resolves to right now: the copy that would be loaded, or `null` for a name
 *  nothing provides any more. Distinct from a name simply being absent from the map — see
 *  {@link resolveCurrentPluginOrigins}. */
export type ResolvedOrigin = { origin: string; path: string } | null;

/** Whether `path` is a regular file. Used for the Data-folder fallback, which
 *  {@link resolvePluginPaths} composes blind: a nested directory sharing a plugin's basename must
 *  not read as that plugin's file, the same rule `rootLevelWinners` and `overwritePluginFiles`
 *  already apply on their own rungs. Any failure — missing, unreadable, mid-uninstall — answers
 *  "not a file", which is the honest reading of all of them for this question. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** What each plugin name in `names` resolves to *right now* — the Mod Management half of drift
 *  (#279 / ADR-0035 § Live mutation). Walks the same overwrite → winning mod → Data ladder
 *  {@link buildExplicitPluginsWithOrigin} does, and differs in exactly one way: the Data rung is
 *  checked for an actual file, so a name nothing provides answers `null` ("would now resolve to:
 *  nothing") instead of a Data path that isn't there. A session build never needed that — it
 *  resolves names that exist — but uninstalling the only provider of a loaded plugin is drift too,
 *  and it is the one kind no re-read can repair.
 *
 *  A name that resolves to nothing is present with a `null` value rather than omitted, so a caller
 *  can tell "asked, and the answer is nothing" from "could not tell" — the difference between
 *  flagging drift and failing to compute it (#334). A name is *omitted* only when the ladder could
 *  not be walked to the end for it, which today means one thing: no resolvable Data folder to check
 *  the last rung against. Keys are case-folded, plugins.txt casing being no more authoritative here
 *  than anywhere else in this module. */
export async function resolveCurrentPluginOrigins(
  names: string[],
  index: FileConflictIndex,
  instanceRoot: string,
  dataFolder: string | undefined,
): Promise<Map<string, ResolvedOrigin>> {
  const [overwriteFiles, winnerByName, winnerModByName] = await Promise.all([
    overwritePluginFiles(instanceRoot),
    Promise.resolve(rootLevelWinners(index)),
    Promise.resolve(rootLevelWinnerMods(index)),
  ]);

  const resolved = await Promise.all(names.map(async (name): Promise<[string, ResolvedOrigin | undefined]> => {
    const key = foldPath(name);

    const overwriteFile = overwriteFiles.get(key);
    if (overwriteFile !== undefined) {
      return [key, { origin: OVERWRITE_ORIGIN, path: join(instanceRoot, 'overwrite', overwriteFile) }];
    }

    const winnerMod = winnerModByName.get(key);
    if (winnerMod !== undefined) {
      return [key, { origin: winnerMod, path: winnerByName.get(key)! }];
    }

    // No resolvable Data folder means the last rung cannot be *checked*, not that it is empty —
    // so the name is left out of the map entirely (unknown) rather than answered `null`. Answering
    // `null` here would flag every vanilla plugin as "resolves to nothing" the moment the game
    // directory failed to resolve, which is #334's rule broken at its source: a marker produced by
    // a computation that did not happen.
    if (dataFolder === undefined) return [key, undefined];
    const dataPath = join(dataFolder, name);
    return [key, (await isFile(dataPath)) ? { origin: DATA_DIRECTORY_ORIGIN, path: dataPath } : null];
  }));

  return new Map(resolved.filter((e): e is [string, ResolvedOrigin] => e[1] !== undefined));
}

type Source = Pick<IModlistSource, 'readPluginOrder' | 'readEnabledPlugins' | 'readModlist'>;
type BuildIndex = (
  entries: Awaited<ReturnType<IModlistSource['readModlist']>>,
  instanceRoot: string,
) => Promise<FileConflictIndex>;

/** Builds the { name, path, origin, participates } list for the backend's `load-explicit` session.
 *  Every plugins.txt line is sent, disabled ones included (#270 / ADR-0035) — the `*` prefix
 *  becomes each plugin's participation rather than deciding whether it is sent at all. Each plugin
 *  also carries the origin Mod Management resolved it from (#269 / ADR-0036). Sole caller is the
 *  "enter editing" call site in extension.ts. */
export async function buildExplicitPluginsWithOrigin(
  source: Source,
  instanceRoot: string,
  dataFolder: string,
  // buildFileConflictIndex now requires a log (#322). This function itself takes no
  // log/channel parameter, so the default stays a no-op rather than growing this
  // signature for it — but the sole real caller (makeEnterEditing, extension.ts) passes
  // its own outputChannel-backed buildIndex explicitly, so the walker's skip/cycle/broken-
  // link surfacing does reach the Output channel in production; this default only fires
  // for a caller (e.g. a test) that doesn't supply one.
  buildIndex: BuildIndex = (entries, root) => buildFileConflictIndex(entries, root, () => {}),
): Promise<ExplicitPlugin[]> {
  const [names, enabled, index, overwriteFiles] = await Promise.all([
    source.readPluginOrder(),
    source.readEnabledPlugins(),
    source.readModlist().then((entries) => buildIndex(entries, instanceRoot)),
    overwritePluginFiles(instanceRoot),
  ]);

  const pathByName = resolvePluginPaths(names, index, dataFolder);
  const winnerModByName = rootLevelWinnerMods(index);
  // Case-folded, like every other name comparison here: plugins.txt casing is not authoritative,
  // and a case difference must not read as "disabled".
  const participatingNames = new Set(enabled.map((n) => n.toLowerCase()));

  return names.map((name) => {
    const participates = participatingNames.has(name.toLowerCase());
    const overwriteFile = overwriteFiles.get(foldPath(name));
    if (overwriteFile !== undefined) {
      return { name, path: join(instanceRoot, 'overwrite', overwriteFile), origin: OVERWRITE_ORIGIN, participates };
    }
    return {
      name,
      path: pathByName.get(name)!,
      origin: winnerModByName.get(name.toLowerCase()) ?? DATA_DIRECTORY_ORIGIN,
      participates,
    };
  });
}
