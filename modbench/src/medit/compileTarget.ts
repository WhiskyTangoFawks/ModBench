/** #416 review: which plugin "Save & Compile" acts on, extracted out of extension.ts's command
 *  closure so the resolution order is unit-testable without a VS Code harness (the same reason
 *  recordPanelMessageRouter/ActiveRecordTracker are their own modules).
 *
 *  Resolution order, highest priority first:
 *  1. A tree row names its plugin directly (`nodePluginName` given) — the Plugins-tree context
 *     menu invocation.
 *  2. No tree row, but the record editor has an active record — that record's *winning* plugin
 *     (`getRecordOwner`), so the title-bar icon compiles what's actually open, not whatever a
 *     QuickPick happens to default to. This is the fix for the bug where a multi-mod session's
 *     editor icon risked compiling the wrong plugin.
 *  3. Neither (the palette with nothing focused) — the caller's own fallback (a QuickPick over
 *     every loaded plugin, in the extension.ts caller).
 */
export interface CompileTarget {
  name: string;
  origin: string;
}

export interface ResolveCompileTargetDeps {
  resolveOrigin: (pluginName: string) => Promise<string | undefined>;
  getRecordOwner: (formKey: string) => Promise<{ plugin: string; origin: string } | undefined>;
  pickPlugin: () => Promise<CompileTarget | undefined>;
  onError: (message: string) => void;
}

export async function resolveCompileTarget(
  nodePluginName: string | undefined,
  activeFormKey: string | undefined,
  deps: ResolveCompileTargetDeps,
): Promise<CompileTarget | undefined> {
  if (nodePluginName !== undefined) {
    // PluginEntry (Mod Management's own vocabulary) carries no origin — resolved the same way
    // registerTrackCommand's own tree-row case does, never read off the row.
    const origin = await deps.resolveOrigin(nodePluginName);
    if (!origin) {
      deps.onError(`Could not resolve which mod "${nodePluginName}" belongs to.`);
      return undefined;
    }
    return { name: nodePluginName, origin };
  }

  if (activeFormKey !== undefined) {
    // #505: PluginRepository.getRecordOwner deliberately lets a transport failure (no backend to
    // ask — ADR-0026 background/recoverable tier at the repository boundary, same posture
    // SessionController.resolveOrigin's own #505 fix documents) propagate as-is; a legitimate
    // "record no longer exists" already resolves to `undefined` here with no message of its own,
    // falling through to the QuickPick fallback below. Treating a rejection the same way is exact
    // parity with that existing case, not a new outcome: this priority tier's only contract is
    // "resolved" or "try the next one," never a message of its own either way.
    const owner = await deps.getRecordOwner(activeFormKey).catch(() => undefined);
    if (owner) return { name: owner.plugin, origin: owner.origin };
  }

  // #530: pickPlugin's body (repository.getPlugins(), then showQuickPick) has no further
  // fallback tier below this one, unlike tier 2's getRecordOwner rejection above — so any
  // rejection out of the picker (a transport failure before Launch mEdit, or anything else it
  // throws) is reported through onError and resolves to no target, the same "report and do
  // nothing" outcome as every other no-target case in this function, rather than propagating as
  // a raw, uncaught toast.
  return deps.pickPlugin().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    deps.onError(`Could not determine which plugin to compile: ${detail}`);
    return undefined;
  });
}
