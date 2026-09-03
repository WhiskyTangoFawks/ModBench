// #680: plugins.txt is the complete inventory the Plugins tree reads; when disk disagrees, the
// file is updated (docs/specs/plugins.md, "Rows are exactly plugins.txt's lines"). The plugins
// twin of startupModlistReconcile.ts.

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { foldPath, rootLevelWinners, type FileConflictIndex } from './fileConflictIndex';
import { isPluginFile } from './masterReader';
import type { ModlistEntry } from './model';
import { discoverImplicitMasters } from './vanillaMasters';

export interface PluginLinesDelta {
  /** Real on-disk names to append, disabled, ascending case-folded. */
  append: string[];
  /** plugins.txt names (as written) whose line goes. */
  prune: string[];
}

/** `provided`: case-folded name → real name of every plugin an enabled mod or overwrite/
 *  provides (the append source, and presence). `inData`: case-folded names in the game's Data
 *  folder — presence only, never an append source; `undefined` (game directory unresolved)
 *  makes presence unknowable, so nothing is pruned. */
export function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  inData: ReadonlySet<string> | undefined,
): PluginLinesDelta {
  const listedFolded = new Set(listed.map(foldPath));
  const append = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const prune = inData === undefined
    ? []
    : listed.filter((name) => !provided.has(foldPath(name)) && !inData.has(foldPath(name)));
  return { append, prune };
}

export interface PluginsReconcileDeps {
  source: {
    readModlist(): Promise<ModlistEntry[]>;
    reconcilePluginLines(delta: (listed: string[]) => PluginLinesDelta): Promise<PluginLinesDelta>;
  };
  instanceRoot: string;
  /** A getter: the game directory setting is editable while Modbench runs. */
  dataFolder: () => Promise<string | undefined>;
  buildIndex: (entries: ModlistEntry[]) => Promise<FileConflictIndex>;
  channel: { info(msg: string): void; error(msg: string): void };
}

/** Root-level plugin files directly under `folder`, case-folded → real name. A `.mohidden`
 *  file fails the extension test, so MO2's hide-by-rename reads as absent. */
async function rootLevelPlugins(folder: string): Promise<Map<string, string>> {
  const dirents = await readdir(folder, { withFileTypes: true });
  return new Map(dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => [foldPath(d.name), d.name]));
}

/** overwrite/ doesn't exist until the first purge deposits a stray file, so ENOENT is "none"
 *  here — for any other folder it is an enumeration failure and aborts the run. */
async function overwritePlugins(instanceRoot: string): Promise<Map<string, string>> {
  try {
    return await rootLevelPlugins(join(instanceRoot, 'overwrite'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
}

/** Every plugin an enabled mod or overwrite/ provides, case-folded → real name, overwrite/ on
 *  top. An implicit master is left out: the tree renders it from Data, never from a line, so a
 *  mod's copy of one must not earn a line. */
function providedPlugins(
  index: FileConflictIndex, overwrite: ReadonlyMap<string, string>, implicit: ReadonlySet<string>,
): Map<string, string> {
  const provided = new Map<string, string>();
  for (const [folded, winnerPath] of rootLevelWinners(index)) {
    if (isPluginFile(winnerPath)) provided.set(folded, basename(winnerPath));
  }
  for (const [folded, real] of overwrite) provided.set(folded, real);
  for (const folded of implicit) provided.delete(folded);
  return provided;
}

/** Bring the active profile's plugins.txt into line with what disk provides. The write is
 *  picked up by the plugins.txt watcher like any other edit; nothing is called from here. Any
 *  failure to enumerate disk aborts the whole run — an errored walk must never read as
 *  "everything vanished" — logged, never thrown (ADR-0026 background tier). Disk is the source
 *  of truth (#93), so the log line is the only record. */
export async function reconcilePluginsWithDisk(deps: PluginsReconcileDeps): Promise<void> {
  try {
    const [index, overwrite, dataFolder] = await Promise.all([
      deps.source.readModlist().then(deps.buildIndex),
      overwritePlugins(deps.instanceRoot),
      deps.dataFolder(),
    ]);
    const inData = dataFolder === undefined ? undefined : new Set((await rootLevelPlugins(dataFolder)).keys());
    const implicit = new Set((await discoverImplicitMasters(dataFolder, () => {})).map(foldPath));
    const provided = providedPlugins(index, overwrite, implicit);

    const { append, prune } = await deps.source.reconcilePluginLines((listed) => pluginLinesDelta(listed, provided, inData));
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
