import * as vscode from 'vscode';

/** The name filter every Modbench list view narrows by — Mods, the merged Plugins tree and
 *  Downloads: one widget, and a durable one.
 *
 *  What matters is where the filter *lives*. The `InputBox` is a
 *  quick-pick-family widget: it hides the moment focus leaves, and clicking a tree row is the
 *  first thing anyone does with a filtered list — a filter living there would clear itself before
 *  it could be used. So the box is an entry mechanism that reports changes and nothing more; the
 *  term lives here, and the rows' narrowing state lives in each view's own provider.
 *  Enter, Escape and clicking away all arrive as the same `onDidHide` event, so none of them can
 *  mean "discard" — clearing is only ever the explicit clear command.
 *
 *  It lives at the composition root, alongside `PluginsTreeComposite` and `LoadoutHeaderProvider`
 *  and for the same reason: it serves views from both bounded contexts, so it can belong to
 *  neither folder. Its deps are structural and it imports only `vscode`, which is what keeps that
 *  true (`src/test/contextBoundary.test.ts`). */
export interface NameFilterDeps {
  /** The view carrying the readout. Structural, so tests need no TreeView: the only two properties
   *  touched are the ones VS Code makes writable for exactly this — a view-scoped statement about
   *  its own contents. */
  view: { description?: string; message?: string };
  /** The view this filter belongs to, e.g. `modbench.modList`. Its two command ids and its
   *  context key are derived from it — `<viewId>.filter` (also what `ctrl+F` is bound to, so it
   *  stays reachable while filtered, by which point the slot-1 icon has swapped),
   *  `<viewId>.clearFilter`, and `<viewId>.filterActive`. Derived rather than passed so the three
   *  views cannot drift into three naming conventions. The literals still appear in
   *  `package.json`, its test, and the integration test's `EXPECTED_COMMANDS` — which is what
   *  catches a declared-but-unregistered command. The context key is deliberately not the record
   *  filter's `modbench.filterActive`: two independent axes, two keys. */
  viewId: string;
  placeholder: string;
  /** Applies the term to the view's provider, which is where the narrowing itself lives. The
   *  second argument is the Mods separator toggle; the other call sites ignore it. */
  setFilter: (text: string, toggleOn: boolean) => void;
  /** Whether the view has any rows left once the term is applied — asked of the provider rather
   *  than inferred, because "matched nothing" and "shows nothing" are different questions. A row
   *  that survives every filter by design (ADR-0026's error row, the Mods tree's pinned Overwrite
   *  row) is content, and a view showing content must not claim there are no matches. */
  hasRows: () => Promise<boolean>;
  /** The Mods tree's group-by-separator option, or absent on views with no option to carry. */
  toggle?: { icon: string; label: string };
}

export interface NameFilter extends vscode.Disposable {
  /** Whatever else this view says about itself, which the readout composes around: the active
   *  profile on Mods, the record filter's source on the Plugins tree. The filter owns
   *  `view.description` outright — two writers would race, and the term has to appear beside
   *  the base rather than replace it. */
  setBaseDescription(text: string | undefined): void;
  /** Restate the readout. For the one view where something else legitimately writes the same
   *  message surface — the Plugins tree, whose reconcile speaks there — this is how
   *  the filter's own statement comes back once the load has stopped talking. */
  refresh(): void;
}

export function registerNameFilter(deps: NameFilterDeps): NameFilter {
  let term = '';
  let toggleOn = true;
  let base: string | undefined;

  /** The persistent filter chip, in the surface the platform already provides. The term
   *  reads first: it is the volatile fact the user just applied, and on the Plugins tree the base
   *  is the *other* filter axis, which the term is naturally read before. */
  const render = (): void => {
    const parts = [term && `"${term}"`, base].filter(Boolean);
    deps.view.description = parts.length > 0 ? parts.join(' · ') : undefined;
  };

  /** The no-matches statement (`TreeView.message`), or nothing. Only ever *clears* a message it
   *  put there itself: the Plugins view uses the same property for the reconcile's own
   *  statement (extension.ts's `say`), and a filter keystroke must not silently erase it.
   *
   *  `generation` drops the answer of a `hasRows` call that a later keystroke has already
   *  overtaken — the provider is asked asynchronously, and out-of-order resolutions would
   *  otherwise leave the message describing a term the user has moved past. */
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
    void vscode.commands.executeCommand('setContext', `${deps.viewId}.filterActive`, text !== '');
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
    vscode.commands.registerCommand(`${deps.viewId}.filter`, openBox),
    // Clearing resets the separator toggle too: the option belongs to the filter that is going away.
    vscode.commands.registerCommand(`${deps.viewId}.clearFilter`, () => apply('', true)),
  ];

  return {
    setBaseDescription: (text) => { base = text; render(); },
    refresh: () => { render(); void renderMessage(); },
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}
