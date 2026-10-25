import { vi } from 'vitest';

/** The items VS Code shows are those whose label holds the typed value, and every item that asks to be shown always. */
export function fakeQuickPick<T extends { label: string; alwaysShow?: boolean }>() {
  const valueListeners: Array<(value: string) => void> = [];
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    value: '',
    title: undefined as string | undefined,
    busy: false,
    items: [] as T[],
    get visibleItems(): T[] {
      return this.items.filter((item) => item.alwaysShow === true || item.label.toLowerCase().includes(this.value.toLowerCase()));
    },
    placeholder: undefined as string | undefined,
    activeItems: [] as T[],
    selectedItems: [] as T[],
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach((cb) => cb()); }),
    dispose: vi.fn(),
    onDidChangeValue: (cb: (value: string) => void) => { valueListeners.push(cb); return { dispose: () => {} }; },
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    type: (value: string) => { qp.value = value; valueListeners.forEach((cb) => cb(value)); },
    accept: (picked: T) => { qp.selectedItems = [picked]; acceptListeners.forEach((cb) => cb()); },
    escape: () => { hideListeners.forEach((cb) => cb()); },
  };
}

/** A quick pick that, once shown, picks the item `choose` returns, or Esc for `undefined`. */
export function quickPickChoosing<T extends { label: string; alwaysShow?: boolean }>(choose: (items: readonly T[]) => T | undefined) {
  const fake = fakeQuickPick<T>();
  fake.qp.show.mockImplementation(() => {
    const picked = choose(fake.qp.items);
    if (picked === undefined) fake.escape();
    else fake.accept(picked);
  });
  return fake.qp;
}
