import { errorMessage } from '../ports/errorMessage';
export interface CompileTarget {
  name: string;
  origin: string;
}

export interface ResolveCompileTargetDeps {
  resolveOrigin: (pluginName: string) => Promise<string | undefined>;
  pickPlugin: () => Promise<CompileTarget | undefined>;
  onError: (message: string) => void;
}

export async function resolveCompileTarget(
  nodePluginName: string | undefined,
  deps: ResolveCompileTargetDeps,
): Promise<CompileTarget | undefined> {
  if (nodePluginName !== undefined) {
    // A tree row carries no origin, so it is resolved rather than read off the row (ADR-0012).
    const origin = await deps.resolveOrigin(nodePluginName);
    if (!origin) {
      deps.onError(`Could not resolve which mod "${nodePluginName}" belongs to.`);
      return undefined;
    }
    return { name: nodePluginName, origin };
  }

  // Nothing catches below this last tier, so a rejection out of the picker is reported here
  // rather than escaping as a raw, uncaught toast.
  return deps.pickPlugin().catch((error: unknown) => {
    const detail = errorMessage(error);
    deps.onError(`Could not determine which plugin to compile: ${detail}`);
    return undefined;
  });
}
