import type { MEditClient } from '../client';

/** The port has no `resolveOrigin` — derived here from `getPlugins()`. A transport failure
 *  degrades to `undefined` (ADR-0019), logged rather than thrown. Shared by Plugins and Editor,
 *  vscode-free: the caller wraps `log` around its own channel. */
export async function resolveOrigin(
  client: Pick<MEditClient, 'getPlugins'>, pluginName: string, log: (msg: string) => void,
): Promise<string | undefined> {
  let plugins;
  try {
    plugins = await client.getPlugins();
  } catch (e) {
    log(`[resolveOrigin] resolveOrigin(${pluginName}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  return plugins.find((p) => p.name === pluginName && p.inLoadOrder)?.origin;
}
