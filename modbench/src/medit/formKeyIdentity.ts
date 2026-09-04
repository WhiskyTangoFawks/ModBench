/** The synthetic FormKey a plugin's header record is indexed at. Its own module, free of any
 *  `vscode` import, so a caller needing only this string does not pull in the tree provider's
 *  whole `vscode.TreeItem` surface. */
export function headerFormKeyFor(pluginName: string): string {
  return `000000:${pluginName}`;
}
