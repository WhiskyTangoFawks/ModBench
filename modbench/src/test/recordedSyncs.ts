import type { ModSyncRun } from '../modCommands/modCommands';

/** `syncMods`, recording each run that added or dropped a modlist line: what the sync wrote. */
export function recordedSyncs(syncMods: ModSyncRun) {
  const wrote: { added: string[]; dropped: string[] }[] = [];
  return {
    wrote,
    syncMods: (async () => {
      const result = await syncMods();
      if (result.applied && result.added.length + result.dropped.length > 0) wrote.push(result);
      return result;
    }) satisfies ModSyncRun,
  };
}
