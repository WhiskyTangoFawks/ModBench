import type {
  MEditClient, LoadOrderOptions, LoadOrderOutcome, LoadOrderPluginInput,
} from './medit/client';

// toolbox.ts's own wiring is `vscode`-heavy to import, so each of its three port-facing calls is
// pulled out here, vscode-free, testable with the in-memory adapter directly.

/** ADR-0016: the rows the game forces on, asked of the backend — undefined whenever there is
 *  nothing to resolve against (no folder, or a game with no Mutagen release). */
export function implicitMastersFrom(
  client: Pick<MEditClient, 'implicitMasters'>, folder: string | undefined, gameRelease: string | undefined,
): Promise<string[] | undefined> {
  return folder === undefined || gameRelease === undefined
    ? Promise.resolve(undefined)
    : client.implicitMasters(folder, gameRelease);
}

/** ADR-0014: Refresh's first step. */
export function rebuildIndexVia(
  client: Pick<MEditClient, 'rebuildIndex'>,
  instanceRoot: string, onFailure: (message: string, detail: string) => void, gameRelease: string,
): Promise<boolean> {
  return client.rebuildIndex(instanceRoot, onFailure, gameRelease);
}

/** ADR-0013: the sync's own PUT. */
export function putLoadOrderVia(
  client: Pick<MEditClient, 'putLoadOrder'>,
  plugins: LoadOrderPluginInput[], dataFolder: string, instanceRoot: string, gameRelease: string,
  options?: LoadOrderOptions,
): Promise<LoadOrderOutcome> {
  return client.putLoadOrder(plugins, dataFolder, instanceRoot, gameRelease, options);
}
