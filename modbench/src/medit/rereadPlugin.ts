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
  /** How many staged edits belong to a given (plugin, origin) — asked about the origin being
   *  *replaced*, since those are the ones the re-read discards. Rejecting is allowed and handled:
   *  see `rereadDriftedPlugin`. */
  stagedChangeCount: (plugin: string, origin: string) => Promise<number>;
  /** The native modal (`showWarningMessage(…, { modal: true, detail })`) — resolves `true` only
   *  if the user picked the affirmative action, `false` for Cancel/Escape/dismiss alike. */
  confirm: (message: string, detail: string) => Promise<boolean>;
  /** `POST /plugins/reread`. Returns whether it succeeded; it does its own error surfacing. */
  reread: (plugin: string, path: string, origin: string) => Promise<boolean>;
  /** ADR-0026 "explicit action failed" tier — the user ran a command that cannot be carried out. */
  report: (message: string) => void;
}

/** Re-reads a drifted plugin, having first stated what it costs. Returns whether the re-read ran.
 *
 *  The confirm appears only when there is staged work to lose, matching `reloadSession`: with
 *  nothing staged a re-read destroys nothing, and a modal for a harmless action trains people to
 *  dismiss the one that matters. What is never skipped is the *question* — if the count cannot be
 *  obtained, it confirms anyway, because a spurious confirm costs one click and a silently-skipped
 *  one risks an unrecoverable discard (the rule `SessionController.hasPendingChanges` already
 *  follows for Reload Session). */
export async function rereadDriftedPlugin(drifted: DriftedPlugin, deps: RereadPluginDeps): Promise<boolean> {
  const { plugin, loadedOrigin, currentOrigin, currentPath } = drifted;

  if (currentPath === null || currentOrigin === null) {
    // Reachable from the palette or from a menu rendered just before the file went away — the row
    // itself does not offer the command in this state (PluginsTreeComposite).
    deps.report(`"${plugin}" no longer resolves to any file, so there is nothing to re-read. Its loaded records are still available.`);
    return false;
  }

  const staged = await countStaged(plugin, loadedOrigin, deps);
  if (staged !== 0) {
    const edits = describeStaged(staged);
    const confirmed = await deps.confirm(
      `Re-read "${plugin}" from ${currentOrigin}?`,
      `${edits} against "${plugin}" will be discarded. They were made against the copy from `
      + `${loadedOrigin}, which is no longer the file this plugin resolves to, so they cannot be `
      + `saved to the new one. Everything else stays as it is — no other plugin is reloaded.`,
    );
    if (!confirmed) return false;
  }

  return deps.reread(plugin, currentPath, currentOrigin);
}

/** How the confirm names what is at stake. `undefined` is the count we could not read — stated as
 *  an unknown quantity rather than guessed at, because a modal that says "1 staged edit" over five
 *  of them is worse than one that declines to count: the user makes an irreversible decision on a
 *  number we invented. */
function describeStaged(staged: number | undefined): string {
  if (staged === undefined) return 'Any staged edits';
  return staged === 1 ? '1 staged edit' : `${staged} staged edits`;
}

/** The staged-edit count, or `undefined` when it can't be read. Never 0 on failure — that would
 *  silently skip the confirm, which is the one outcome this must not produce (the rule
 *  `SessionController.hasPendingChanges` already follows for Reload Session). */
async function countStaged(plugin: string, origin: string, deps: RereadPluginDeps): Promise<number | undefined> {
  try {
    return await deps.stagedChangeCount(plugin, origin);
  } catch {
    return undefined;
  }
}
