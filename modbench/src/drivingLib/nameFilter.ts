import * as vscode from 'vscode';

/** The term lives here, not in the `InputBox`: that widget hides the moment focus leaves, and
 *  clicking a row is the first thing anyone does with a filtered list. */
export interface NameFilterDeps {
  /** Structural rather than a `TreeView`: the only properties touched are the two VS Code makes
   *  writable. */
  view: { description?: string; message?: string };
  /** `modbench.<object>`, the catalog's prefix, which names the context key the view's title bar
   *  swaps filter and clear on. The key is not the record filter's `modbench.record.filterActive`. */
  object: string;
  placeholder: string;
  /** Applies the term to the view's provider, which is where the narrowing itself lives. The
   *  second argument is the Mods separator toggle; the other call sites ignore it. */
  setFilter: (text: string, toggleOn: boolean) => void;
  /** Asked of the provider rather than inferred: a row that survives every filter by design (the
   *  error row, the pinned Overwrite row) is content, and a view showing content must not claim
   *  there are no matches. */
  hasRows: () => Promise<boolean>;
  /** The Mods tree's group-by-separator option, or absent on views with no option to carry. */
  toggle?: { icon: string; label: string };
  /** Where the term sits beside the base description; before it unless the view says otherwise. */
  termPlacement?: 'beforeBase' | 'afterBase';
  /** What the view's message line says about the view itself, asked again on each row change.
   *  The no-match message takes the line while a filter matches nothing. */
  viewMessage?: () => string | undefined;
  /** The part of the view's message that stays beside the no-match message. */
  standingMessage?: () => string | undefined;
  onRowsChanged?: vscode.Event<unknown>;
  /** What else `viewMessage` reads changed: a sync's failure began, changed or cleared. */
  onViewMessageChanged?: (listener: () => void) => { dispose(): void };
}

/** One view's message line, said by several writers: each part present, in order. */
export function messageLine(...parts: (string | undefined)[]): string | undefined {
  const said = parts.filter((part) => part !== undefined);
  return said.length > 0 ? said.join(' ') : undefined;
}

/** A system command's part of its view's message line. */
export interface SyncMessage {
  /** The failure standing now, or undefined. */
  message(): string | undefined;
  onMessageChanged(listener: () => void): { dispose(): void };
}

/** Several system commands' parts of one view's message line, as one. */
export function joinSyncMessages(...parts: SyncMessage[]): SyncMessage {
  return {
    message: () => messageLine(...parts.map((part) => part.message())),
    onMessageChanged: (listener) => {
      const subscriptions = parts.map((part) => part.onMessageChanged(listener));
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    },
  };
}

export interface NameFilter extends vscode.Disposable {
  /** Whatever else this view says about itself. The filter owns `view.description` outright —
   *  two writers would race — and the term appears beside the base rather than replacing it. */
  setBaseDescription(text: string | undefined): void;
  /** Restate the readout, when something it reads besides the rows has changed. */
  refresh(): void;
  open(): void;
  clear(): void;
}

export function registerNameFilter(deps: NameFilterDeps): NameFilter {
  let term = '';
  let toggleOn = true;
  let base: string | undefined;

  const render = (): void => {
    const quoted = term && `"${term}"`;
    const parts = (deps.termPlacement === 'afterBase' ? [base, quoted] : [quoted, base]).filter(Boolean);
    deps.view.description = parts.length > 0 ? parts.join(' · ') : undefined;
  };

  // `lastWritten` is what this filter itself last put on the line — every recompute leaves the
  // line alone once something else holds it.
  let generation = 0; // drops a `hasRows` answer a later call has already overtaken
  let lastWritten: string | undefined;
  const ownsMessage = (): boolean => deps.view.message === undefined || deps.view.message === lastWritten;
  const renderMessage = async (): Promise<void> => {
    const mine = ++generation;
    const text = term === '' || (await deps.hasRows()) ? deps.viewMessage?.() : messageLine(`No matches for "${term}".`, deps.standingMessage?.());
    if (mine !== generation) return;
    if (!ownsMessage()) return;
    if (text !== undefined) {
      deps.view.message = text;
      lastWritten = text;
    } else if (lastWritten !== undefined) {
      deps.view.message = undefined;
      lastWritten = undefined;
    }
  };

  // The toggle belongs to the filter, so it goes when the term does, by whatever route.
  const apply = (text: string, nextToggleOn: boolean): void => {
    term = text;
    toggleOn = text === '' || nextToggleOn;
    deps.setFilter(text, toggleOn);
    void vscode.commands.executeCommand('setContext', `${deps.object}.filterActive`, text !== '');
    render();
    void renderMessage();
  };

  const openBox = () => {
    const box = vscode.window.createInputBox();
    box.placeholder = deps.placeholder;
    // Reopening edits the live filter rather than starting over — the term outlived the last box.
    box.value = term;
    const updateButtons = () => {
      if (!deps.toggle) return;
      box.buttons = [{ iconPath: new vscode.ThemeIcon(deps.toggle.icon), tooltip: `${deps.toggle.label} (${toggleOn ? 'on' : 'off'})` }];
    };
    updateButtons();
    box.onDidTriggerButton(() => {
      apply(box.value, !toggleOn);
      updateButtons();
    });
    box.onDidChangeValue((text) => {
      apply(text, toggleOn);
      updateButtons();
    });
    // Dispose the widget, keep the filter — this one line is what makes the filter durable.
    box.onDidHide(() => box.dispose());
    box.show();
  };

  // A context key outlives an extension host restart; the filter it describes does not.
  void vscode.commands.executeCommand('setContext', `${deps.object}.filterActive`, false);
  const disposables = [
    ...(deps.onRowsChanged ? [deps.onRowsChanged(() => void renderMessage())] : []),
    ...(deps.onViewMessageChanged ? [deps.onViewMessageChanged(() => void renderMessage())] : []),
  ];

  return {
    setBaseDescription: (text) => { base = text; render(); },
    refresh: () => { render(); void renderMessage(); },
    open: openBox,
    clear: () => apply('', true),
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}

/** The catalog's filter pair acts on the view it is given, else the focused one. A title icon
 *  cannot name its view, so `<view id>.filterHere` and `.clearFilterHere` fire the pair with it. */
export function registerFilterCommands(
  focusedViewId: () => string | undefined,
  filters: ReadonlyMap<string, Pick<NameFilter, 'open' | 'clear'>>,
  nothingFocused: () => void,
): vscode.Disposable[] {
  const on = (act: (filter: Pick<NameFilter, 'open' | 'clear'>) => void) => (viewId: unknown = focusedViewId()) => {
    const filter = typeof viewId === 'string' ? filters.get(viewId) : undefined;
    if (filter === undefined) nothingFocused();
    else act(filter);
  };
  const open = on((filter) => filter.open());
  const clear = on((filter) => filter.clear());
  return [
    vscode.commands.registerCommand('modbench.filter', open),
    vscode.commands.registerCommand('modbench.clearFilter', clear),
    ...[...filters.keys()].flatMap((viewId) => [
      vscode.commands.registerCommand(`${viewId}.filterHere`, () => vscode.commands.executeCommand('modbench.filter', viewId)),
      vscode.commands.registerCommand(`${viewId}.clearFilterHere`, () => vscode.commands.executeCommand('modbench.clearFilter', viewId)),
    ]),
  ];
}
