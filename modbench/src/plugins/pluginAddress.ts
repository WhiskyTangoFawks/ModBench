import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';

const spelling = ({ name, origin }: PluginAddress): string => JSON.stringify([origin, name]);

/** Every fact is filed under origin and filename as spelled (ADR-0012). A reader whose spelling
 *  matches none exactly reads the one plugin it matches without case, never one of several. */
export class ByPluginAddress<T> {
  private readonly bySpelling = new Map<string, Map<string, T>>();

  set(plugin: PluginAddress, value: T): void {
    const key = pluginAddressKey(plugin);
    const spellings = this.bySpelling.get(key) ?? new Map<string, T>();
    spellings.set(spelling(plugin), value);
    this.bySpelling.set(key, spellings);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, plugin: PluginAddress, item: U): void {
    this.set(plugin, [...(this.exact(plugin) ?? []), item]);
  }

  get(plugin: PluginAddress): T | undefined {
    return this.exact(plugin) ?? this.onlyMatch(plugin);
  }

  has(plugin: PluginAddress): boolean {
    return this.get(plugin) !== undefined;
  }

  private exact(plugin: PluginAddress): T | undefined {
    return this.bySpelling.get(pluginAddressKey(plugin))?.get(spelling(plugin));
  }

  private onlyMatch(plugin: PluginAddress): T | undefined {
    const spellings = this.bySpelling.get(pluginAddressKey(plugin));
    return spellings?.size === 1 ? [...spellings.values()][0] : undefined;
  }
}
