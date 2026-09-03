// #680: plugins.txt is the complete, authoritative inventory the Plugins tree reads — never a
// view enriched with what disk has and the file lacks. When disk disagrees, the file is updated,
// the way MO2's own refresh + full rewrite converges (`references/modorganizer/src/pluginlist.cpp`,
// `PluginList::refresh()`: a discovered file joins the model, a vanished one is erased, and the
// whole model is written back). Modbench's edit is surgical instead of a rewrite (ADR-0021):
// append a disabled line per newly-discovered plugin, remove the line of a plugin nothing
// provides. The Mods tree already does exactly this for modlist.txt vs mods/ (#93,
// startupModlistReconcile.ts); this is the plugins twin.

import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { foldPath, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { PLUGIN_EXTENSIONS } from './masterReader';
import type { ModlistEntry } from './model';

export interface PluginLinesDelta {
  /** Real on-disk names to append, disabled, at the winning end — ascending case-folded, so a
   *  batch lands in a deterministic order rather than `readdir`'s. */
  append: string[];
  /** plugins.txt names (as written) whose line goes. */
  prune: string[];
}

/** The pure core: `listed` is plugins.txt's entry names in file order; `provided` maps the
 *  case-folded name of every root-level plugin file an enabled mod or overwrite/ provides to its
 *  real on-disk name (append source AND presence); `dataFolded` is the case-folded names in the
 *  game's Data folder (presence only — DLC/Creation Club lines are kept, never created here;
 *  ADR-0044 leaves vanilla to the backend). `undefined` Data means the game directory is
 *  unresolved: with presence unknowable, nothing is pruned, but append needs no Data and still
 *  runs. */
export function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  dataFolded: ReadonlySet<string> | undefined,
): PluginLinesDelta {
  const listedFolded = new Set(listed.map(foldPath));
  const append = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const prune = dataFolded === undefined
    ? []
    : listed.filter((name) => !provided.has(foldPath(name)) && !dataFolded.has(foldPath(name)));
  return { append, prune };
}

export interface PluginsReconcileDeps {
  source: {
    readModlist(): Promise<ModlistEntry[]>;
    reconcilePluginLines(delta: (listed: string[]) => PluginLinesDelta): Promise<PluginLinesDelta>;
  };
  instanceRoot: string;
  /** A getter, like `PluginListProviderOptions.dataFolder`: the game directory setting is
   *  editable while Modbench runs. Resolves `undefined` when unresolved. */
  dataFolder: () => Promise<string | undefined>;
  buildIndex: (entries: ModlistEntry[], instanceRoot: string) => Promise<FileConflictIndex>;
  channel: { info(msg: string): void; error(msg: string): void };
}

const isPlugin = (name: string): boolean => PLUGIN_EXTENSIONS.has(extname(name).toLowerCase());

/** Root-level plugin files directly under `folder`, case-folded → real name. Missing folder
 *  (`overwrite/` isn't created until the first purge deposits a stray) means none; any other
 *  readdir failure propagates, so the caller aborts rather than reading it as "nothing here". A
 *  `.mohidden` file's extension is `.mohidden`, so MO2's hide-by-rename is excluded by the same
 *  extension test — hidden is not present, exactly as MO2's own VFS has it. */
async function rootLevelPlugins(folder: string): Promise<Map<string, string>> {
  let dirents;
  try {
    dirents = await readdir(folder, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  return new Map(dirents.filter((d) => d.isFile() && isPlugin(d.name)).map((d) => [foldPath(d.name), d.name]));
}

/** Bring the active profile's plugins.txt into line with what disk provides, then stop: the
 *  write re-fires the plugins.txt watcher, which is how the tree and Editing's load-order sync
 *  learn of it (ADR-0044) — no direct call to either from here. Runs on startup and behind the
 *  mods/, modlist.txt and overwrite/ watchers (extension.ts); never on the plugins.txt watcher,
 *  since an edit to the file changes nothing on disk. Idempotent: a run that finds nothing to
 *  do writes nothing. Any failure to enumerate disk aborts the whole run — a walk that errored
 *  must never read as "everything vanished" and mass-prune — logged, never thrown (ADR-0026
 *  background tier; the same posture as `reconcileModlistWithModsDir`). Disk is the source of
 *  truth (the #93 ruling), so no prompt and no toast: the log line is the record. */
export async function reconcilePluginsWithDisk(deps: PluginsReconcileDeps): Promise<void> {
  try {
    const [index, overwrite, dataFolder] = await Promise.all([
      deps.source.readModlist().then((entries) => deps.buildIndex(entries, deps.instanceRoot)),
      rootLevelPlugins(join(deps.instanceRoot, 'overwrite')),
      deps.dataFolder(),
    ]);
    // Enabled mods' winners first, then overwrite/ on top — winning-most, and the real name a
    // line gets when both provide a plugin.
    const provided = new Map<string, string>();
    for (const [folded, winnerPath] of rootLevelWinners(index)) {
      if (isPlugin(winnerPath)) provided.set(folded, basename(winnerPath));
    }
    for (const [folded, real] of overwrite) provided.set(folded, real);
    const dataFolded = dataFolder === undefined
      ? undefined
      : new Set((await rootLevelPlugins(dataFolder)).keys());

    const { append, prune } = await deps.source.reconcilePluginLines((listed) => pluginLinesDelta(listed, provided, dataFolded));
    if (append.length > 0) {
      deps.channel.info(`[modmanager] Plugins reconcile appended ${append.length} disabled plugins.txt line(s) for plugin(s) on disk with no line: ${append.join(', ')}`);
    }
    if (prune.length > 0) {
      deps.channel.info(`[modmanager] Plugins reconcile pruned ${prune.length} plugins.txt line(s) with no plugin on disk: ${prune.join(', ')}`);
    }
  } catch (err) {
    deps.channel.error(`[modmanager] Plugins reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
