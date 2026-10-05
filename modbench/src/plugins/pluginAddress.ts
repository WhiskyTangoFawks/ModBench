/** ADR-0012. */
export function pluginAddressKey(name: string, origin: string): string {
  return `${origin.toLowerCase()}|${name.toLowerCase()}`;
}

/** Every fact is filed and read under origin and filename (ADR-0012). */
export class ByPluginAddress<T> {
  private readonly byAddress = new Map<string, T>();

  set(name: string, origin: string, value: T): void {
    this.byAddress.set(pluginAddressKey(name, origin), value);
  }

  // `this` narrows to an array-valued instance.
  append<U>(this: ByPluginAddress<U[]>, name: string, origin: string, item: U): void {
    const addressKey = pluginAddressKey(name, origin);
    this.byAddress.set(addressKey, [...(this.byAddress.get(addressKey) ?? []), item]);
  }

  get(name: string, origin: string): T | undefined {
    return this.byAddress.get(pluginAddressKey(name, origin));
  }

  has(name: string, origin: string): boolean {
    return this.byAddress.has(pluginAddressKey(name, origin));
  }
}
