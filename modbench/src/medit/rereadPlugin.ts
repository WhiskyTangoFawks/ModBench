/** #279 / ADR-0035 § Live mutation: the Re-read decision — state the consequence, then act, and
 *  never touch the session when the user declines. Same shape and the same reasons as
 *  `reloadSession.ts`: no VS Code types in the signature, so `extension.ts` wires the real modal
 *  and the real HTTP call and this stays unit-testable without a harness. */

/** The drifted plugin, as the row knows it. `currentPath`/`currentOrigin` are `null` when the
 *  name resolves to nothing at all, which is the one drift no re-read can repair. */
export interface DriftedPlugin {
  plugin: string;
  loadedOrigin: string;
  currentOrigin: string | null;
  currentPath: string | null;
}

export interface RereadPluginDeps {
  /** `POST /plugins/reread`. Returns whether it succeeded; it does its own error surfacing. */
  reread: (plugin: string, path: string, origin: string) => Promise<boolean>;
  /** ADR-0026 "explicit action failed" tier — the user ran a command that cannot be carried out. */
  report: (message: string) => void;
}

/** Re-reads a drifted plugin. Returns whether the re-read ran.
 *
 *  #410/ADR-0041: no confirm. It existed to warn that the re-read would discard staged edits
 *  against the copy being replaced; with the pending model gone a re-read destroys nothing, and a
 *  modal for a harmless action trains people to dismiss the one that matters. When editing returns
 *  as working-tree text (#415), uncommitted work is git's to report, not a modal's. */
export async function rereadDriftedPlugin(drifted: DriftedPlugin, deps: RereadPluginDeps): Promise<boolean> {
  const { plugin, currentOrigin, currentPath } = drifted;

  if (currentPath === null || currentOrigin === null) {
    // Reachable from the palette or from a menu rendered just before the file went away — the row
    // itself does not offer the command in this state (PluginsTreeComposite).
    deps.report(`"${plugin}" no longer resolves to any file, so there is nothing to re-read. Its loaded records are still available.`);
    return false;
  }

  return deps.reread(plugin, currentPath, currentOrigin);
}
