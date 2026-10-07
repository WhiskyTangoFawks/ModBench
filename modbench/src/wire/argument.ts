import type { PluginAddress } from './pluginAddress';

// commands.md, Argument: what identifies the object a row or webview context stands for.
// A record names no plugin when it stands for the record's winning copy.
type Argument =
  | { readonly kind: 'record'; readonly formKey: string; readonly plugin?: PluginAddress }
  | { readonly kind: 'plugin'; readonly plugin: PluginAddress }
  | { readonly kind: 'mod'; readonly name: string };

export type ArgumentOf<K extends Argument['kind']> = Extract<Argument, { kind: K }>;
