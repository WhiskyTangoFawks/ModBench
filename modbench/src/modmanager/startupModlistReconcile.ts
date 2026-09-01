/** #93: the one-time startup reconciliation of modlist.txt against mods/ — the on-load
 *  complement of the live mods/ watcher (registerModsAutoRegisterWatcher), covering changes
 *  made while Modbench wasn't running. Both directions: register folders with no entry,
 *  prune entries whose folder is gone. Disk is the source of truth (maintainer ruling), so
 *  neither direction prompts or toasts — the log line is the record. Never throws:
 *  activation must not die on a reconcile blip, so a failure is logged and swallowed
 *  (ADR-0026 background tier).
 *
 *  No VS Code types — the same extracted-handler seam the checkbox handlers use, so this is
 *  unit-testable without a harness. */
export async function reconcileModlistWithModsDir(
  source: { registerUnlistedMods(): Promise<string[]>; pruneDeadEntries(): Promise<string[]> },
  invalidate: () => void,
  channel: { info(msg: string): void; error(msg: string): void },
): Promise<void> {
  try {
    const added = await source.registerUnlistedMods();
    const pruned = await source.pruneDeadEntries();
    if (added.length > 0) {
      channel.info(`[modmanager] Startup reconcile registered ${added.length} unlisted mod folder(s): ${added.join(', ')}`);
    }
    if (pruned.length > 0) {
      channel.info(`[modmanager] Startup reconcile pruned ${pruned.length} modlist entr${pruned.length === 1 ? 'y' : 'ies'} with no mods/ folder: ${pruned.join(', ')}`);
    }
    if (added.length + pruned.length > 0) invalidate();
  } catch (err) {
    channel.error(`[modmanager] Startup modlist reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
