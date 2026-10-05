import { vi } from 'vitest';

export function fakeQuickPick<T>() {
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    items: [] as T[],
    placeholder: undefined as string | undefined,
    activeItems: [] as T[],
    selectedItems: [] as T[],
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach((cb) => cb()); }),
    dispose: vi.fn(),
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    accept: (picked: T) => { qp.selectedItems = [picked]; acceptListeners.forEach((cb) => cb()); },
    escape: () => { hideListeners.forEach((cb) => cb()); },
  };
}

/** A quick pick that, once shown, picks the item `choose` returns, or Esc for `undefined`. */
export function quickPickChoosing<T>(choose: (items: readonly T[]) => T | undefined) {
  const fake = fakeQuickPick<T>();
  fake.qp.show.mockImplementation(() => {
    const picked = choose(fake.qp.items);
    if (picked === undefined) fake.escape();
    else fake.accept(picked);
  });
  return fake.qp;
}
