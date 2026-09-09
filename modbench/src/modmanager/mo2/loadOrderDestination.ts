// Table 2 of 2: where the running game itself reads its load order (Plugins.txt), keyed by
// release. Separate from gamePaths.ts: Fallout 4's install folder has a space and this AppData
// folder doesn't — the two vary independently.

const LOAD_ORDER_APPDATA_FOLDER: Record<string, string> = {
  Fallout4: 'Fallout4',
};

/** The AppData\Local subfolder holding this release's Plugins.txt, or `undefined` when the
 *  table holds none — the autodetector's signal to give up rather than guess one. */
export function loadOrderAppDataFolder(release: string): string | undefined {
  return LOAD_ORDER_APPDATA_FOLDER[release];
}
