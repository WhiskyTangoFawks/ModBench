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
    // A tree row carries no origin, so it is resolved rather than read off the row (ADR-0036).
    const origin = await deps.resolveOrigin(nodePluginName);
    if (!origin) {
      deps.onError(`Could not resolve which mod "${nodePluginName}" belongs to.`);
      return undefined;
    }
    return { name: nodePluginName, origin };
  }

  if (activeFormKey !== undefined) {
    // The record's own winning plugin, so the title-bar icon compiles what is open rather than
    // whatever the picker below defaults to. This tier never speaks: a rejection falls through
    // exactly as an unknown FormKey does.
    const owner = await deps.getRecordOwner(activeFormKey).catch(() => undefined);
    if (owner) return { name: owner.plugin, origin: owner.origin };
  }

  // Nothing catches below this last tier, so a rejection out of the picker is reported here
  // rather than escaping as a raw, uncaught toast.
  return deps.pickPlugin().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    deps.onError(`Could not determine which plugin to compile: ${detail}`);
    return undefined;
  });
}
