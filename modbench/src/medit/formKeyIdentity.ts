/** The synthetic FormKey a plugin's header record is indexed at. Its own module — no `vscode`
 *  import — so anything needing it (a header field edit, `eslFlagRemovalPrompt.ts`'s coherence
 *  prompt) doesn't drag in `PluginTreeProvider.ts`'s whole `vscode.TreeItem` surface just for
 *  this one string. `PluginTreeProvider.ts` re-exports it for its own existing callers. */
export function headerFormKeyFor(pluginName: string): string {
  return `000000:${pluginName}`;
}
