import { present } from '../ports/present';

/** The InputBox double every per-view name filter test needs — enough of `vscode.InputBox` for
 *  `registerNameFilter`'s `openBox`, nothing else. */
export class FakeInputBox {
  value = '';
  placeholder = '';
  buttons: { iconPath: unknown; tooltip: string }[] = [];
  private changeHandlers: ((v: string) => void)[] = [];
  onDidChangeValue(cb: (v: string) => void) { this.changeHandlers.push(cb); return { dispose: () => undefined }; }
  onDidHide() { return { dispose: () => undefined }; }
  onDidTriggerButton() { return { dispose: () => undefined }; }
  show(): void { /* no-op */ }
  dispose(): void { /* no-op */ }
  type(text: string): void { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
}

export interface FilterBoxState {
  commands: Map<string, (...args: unknown[]) => unknown>;
  boxes: FakeInputBox[];
}

export function makeFilterBoxState(): FilterBoxState {
  return { commands: new Map(), boxes: [] };
}

/** `vscode.window`'s slice a per-view test's `vi.mock('vscode', ...)` spreads in, alongside
 *  whatever `createTreeView`/decoration stub that view's own registration needs. */
export function filterBoxWindowMock(state: FilterBoxState) {
  return {
    createInputBox: () => {
      const box = new FakeInputBox();
      state.boxes.push(box);
      return box;
    },
  };
}

export function filterBoxCommandsMock(state: FilterBoxState) {
  return {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
      state.commands.set(id, cb);
      return { dispose: () => state.commands.delete(id) };
    },
    executeCommand: () => Promise.resolve(),
  };
}

export const commandInvoker = (state: FilterBoxState) =>
  (id: string) => present(state.commands.get(id), `the "${id}" command`);

export const currentBoxOf = (state: FilterBoxState) =>
  () => present(state.boxes.at(-1), 'the most recently created input box');

/** A real recompute chain (an Instance re-read, a provider rebuild, `hasRows()`) settles over a
 *  few ticks; the loop fails on its own assertion, never the runner's timeout. */
export async function waitForMessage(
  view: { message?: string }, predicate: (m: string | undefined) => boolean, label: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate(view.message)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}; last message: ${String(view.message)}`);
}
