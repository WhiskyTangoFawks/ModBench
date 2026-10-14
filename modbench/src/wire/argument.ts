import type { PluginAddress } from './pluginAddress';

// commands.md, Argument: what identifies the object a row or webview context stands for.
// A record names no plugin when it stands for the record's winning copy.
export type Argument =
  | { readonly kind: 'record'; readonly formKey: string; readonly plugin?: PluginAddress }
  | { readonly kind: 'plugin'; readonly plugin: PluginAddress }
  | { readonly kind: 'mod'; readonly name: string }
  | { readonly kind: 'separator'; readonly name: string }
  | { readonly kind: 'downloadedFile'; readonly name: string }
  | { readonly kind: 'archive' | 'folder'; readonly path: string }
  | { readonly kind: 'file'; readonly origin: { readonly kind: 'mod'; readonly name: string } | { readonly kind: 'runtimeOutput' }; readonly relativePath: string };

export type ArgumentOf<K extends Argument['kind']> = Extract<Argument, { kind: K }>;
