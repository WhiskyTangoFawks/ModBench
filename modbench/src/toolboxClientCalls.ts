import type { MEditClient } from './client';

// toolbox.ts's own wiring is `vscode`-heavy to import, so each of its port-facing calls is
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
