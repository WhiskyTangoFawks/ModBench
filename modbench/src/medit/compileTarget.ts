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
    const owner = await deps.getRecordOwner(activeFormKey);
    if (owner) return { name: owner.plugin, origin: owner.origin };
  }

  return deps.pickPlugin();
}
