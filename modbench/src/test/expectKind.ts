type Kinded = { readonly kind: string };

const isKind = <T extends Kinded, K extends T['kind']>(value: T, kind: K): value is Extract<T, { readonly kind: K }> => value.kind === kind;

export function expectKind<T extends Kinded, K extends T['kind']>(value: T, kind: K): Extract<T, { readonly kind: K }> {
  if (isKind(value, kind)) return value;
  throw new Error(`expected ${kind}, got ${JSON.stringify(value)}`);
}
