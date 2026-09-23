import * as vscode from 'vscode';

/** The term lives here, not in the `InputBox`: that widget hides the moment focus leaves, and
 *  clicking a row is the first thing anyone does with a filtered list. It serves both bounded
 *  contexts, so it belongs to neither folder. */
export interface NameFilterDeps {
  /** Structural rather than a `TreeView`: the only properties touched are the two VS Code makes
   *  writable. */
  view: { description?: string; message?: string };
  /** `modbench.<object>`, the catalog's prefix. The two command ids and the context key derive
   *  from it, so the three views cannot drift apart. The key is not the record filter's
   *  `modbench.filterActive`. */
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
  /** The view's own row-change signal. The message recomputes off it exactly as it does off a
   *  keystroke, so a row change with nobody typing never leaves it stale. */
  onRowsChanged?: vscode.Event<unknown>;
}

export interface NameFilter extends vscode.Disposable {
  /** Whatever else this view says about itself. The filter owns `view.description` outright —
   *  two writers would race — and the term appears beside the base rather than replacing it. */
  setBaseDescription(text: string | undefined): void;
  /** Restate the readout, for the one view where something else legitimately writes the same
   *  message surface. */
  refresh(): void;
}

export function registerNameFilter(deps: NameFilterDeps): NameFilter {
  let term = '';
  let toggleOn = true;
  let base: string | undefined;

  // The term reads first: it is the volatile fact the user just applied.
  const render = (): void => {
    const parts = [term && `"${term}"`, base].filter(Boolean);
    deps.view.description = parts.length > 0 ? parts.join(' · ') : undefined;
  };

  // Only ever clears a message it put there itself: the reconcile writes the same property.
  // `generation` drops a `hasRows` answer a later keystroke has already overtaken.
  let generation = 0;
  let messageShown = false;
  const renderMessage = async (): Promise<void> => {
    const mine = ++generation;
    const empty = term !== '' && !(await deps.hasRows());
    if (mine !== generation) return;
    if (empty) {
      deps.view.message = `No matches for "${term}".`;
      messageShown = true;
    } else if (messageShown) {
      deps.view.message = undefined;
      messageShown = false;
    }
  };

  const apply = (text: string, nextToggleOn: boolean): void => {
    term = text;
    toggleOn = nextToggleOn;
    deps.setFilter(text, nextToggleOn);
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
    box.onDidChangeValue((text) => apply(text, toggleOn));
    // Dispose the widget, keep the filter — this one line is what makes the filter durable.
    box.onDidHide(() => box.dispose());
    box.show();
  };

  const disposables = [
    vscode.commands.registerCommand(`${deps.object}.filter`, openBox),
    // Clearing resets the separator toggle too: the option belongs to the filter that is going away.
    vscode.commands.registerCommand(`${deps.object}.clearFilter`, () => apply('', true)),
    ...(deps.onRowsChanged ? [deps.onRowsChanged(() => void renderMessage())] : []),
  ];

  return {
    setBaseDescription: (text) => { base = text; render(); },
    refresh: () => { render(); void renderMessage(); },
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}
