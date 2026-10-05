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
