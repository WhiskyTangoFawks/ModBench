import { present } from '../../ports/present';
import type * as vscode from 'vscode';

/** The InputBox double every per-view name filter test needs — enough of `vscode.InputBox` for
 *  `registerNameFilter`'s `openBox`, nothing else. */
export class FakeInputBox {
  value = '';
  placeholder = '';
  buttons: { iconPath: unknown; tooltip: string }[] = [];
  disposed = false;
  private changeHandlers: ((v: string) => void)[] = [];
  private hideHandlers: (() => void)[] = [];
  private buttonHandlers: ((b: unknown) => void)[] = [];
  onDidChangeValue(cb: (v: string) => void) { this.changeHandlers.push(cb); return { dispose: () => undefined }; }
  onDidHide(cb: () => void) { this.hideHandlers.push(cb); return { dispose: () => undefined }; }
  onDidTriggerButton(cb: (b: unknown) => void) { this.buttonHandlers.push(cb); return { dispose: () => undefined }; }
  show(): void { /* no-op */ }
  dispose(): void { this.disposed = true; }
  type(text: string): void { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
  hide(): void { this.hideHandlers.forEach((cb) => cb()); }
  pressButton(): void { this.buttonHandlers.forEach((cb) => cb(this.buttons[0])); }
}

export interface FilterBoxState {
  commands: Map<string, (...args: unknown[]) => unknown>;
  boxes: FakeInputBox[];
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

type Listener<E> = (event: E) => void;
const noDisposable = () => ({ dispose: () => undefined });
const NO_ROWS: vscode.TreeDataProvider<unknown> = { getTreeItem: () => ({}), getChildren: () => [] };

/** The `vscode.TreeView` every name-filtered view's test shares: what the view reads (`selection`,
 *  `visible`, `reveal`) and sets (`description`, `message`), and the events the test fires at it. */
export class FakeTreeView {
  description?: string;
  message?: string;
  selection: readonly unknown[] = [];
  visible = true;
  revealRefusal: Error | undefined;
  readonly reveals: { label: unknown; options: unknown }[] = [];
  private readonly listeners = {
    selection: [] as Listener<{ selection: readonly unknown[] }>[],
    visibility: [] as Listener<{ visible: boolean }>[],
    expand: [] as Listener<{ element: unknown }>[],
    collapse: [] as Listener<{ element: unknown }>[],
  };

  constructor(readonly treeDataProvider: vscode.TreeDataProvider<unknown> = NO_ROWS, readonly options: Omit<vscode.TreeViewOptions<unknown>, 'treeDataProvider'> = {}) {}

  onDidChangeSelection = (listener: Listener<{ selection: readonly unknown[] }>) => this.subscribe(this.listeners.selection, listener);
  onDidChangeVisibility = (listener: Listener<{ visible: boolean }>) => this.subscribe(this.listeners.visibility, listener);
  onDidExpandElement = (listener: Listener<{ element: unknown }>) => this.subscribe(this.listeners.expand, listener);
  onDidCollapseElement = (listener: Listener<{ element: unknown }>) => this.subscribe(this.listeners.collapse, listener);
  onDidChangeCheckboxState = noDisposable;
  dispose = (): void => undefined;

  reveal(element: { label: unknown }, options: unknown): Promise<void> {
    if (this.revealRefusal) return Promise.reject(this.revealRefusal);
    this.reveals.push({ label: element.label, options });
    return Promise.resolve();
  }

  selectRows(rows: readonly unknown[]): void {
    this.selection = rows;
    this.listeners.selection.forEach((listener) => { listener({ selection: rows }); });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.listeners.visibility.forEach((listener) => { listener({ visible }); });
  }

  expand(element: unknown): void { this.listeners.expand.forEach((listener) => { listener({ element }); }); }
  collapse(element: unknown): void { this.listeners.collapse.forEach((listener) => { listener({ element }); }); }

  private subscribe<E>(listeners: Listener<E>[], listener: Listener<E>) {
    listeners.push(listener);
    return noDisposable();
  }
}

/** The views a test's `createTreeView` made, by id and in order. */
export class FakeTreeViews {
  private readonly made: { id: string; view: FakeTreeView }[] = [];

  create = (id: string, { treeDataProvider, ...options }: vscode.TreeViewOptions<unknown>): FakeTreeView => {
    const view = new FakeTreeView(treeDataProvider, options);
    this.made.push({ id, view });
    return view;
  };

  view(id?: string): FakeTreeView {
    const found = id === undefined ? this.made[0] : this.made.find((entry) => entry.id === id);
    return present(found, id === undefined ? 'the registered tree view' : `the "${id}" tree view`).view;
  }

  clear(): void { this.made.length = 0; }
}
