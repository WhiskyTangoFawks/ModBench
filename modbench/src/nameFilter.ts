import * as vscode from 'vscode';

/** The name filter every Modbench list view narrows by — Mods, the merged Plugins tree and
 *  Downloads (#247 made it one widget; [#255](https://github.com/WhiskyTangoFawks/ModBench/issues/255)
 *  made it durable).
 *
 *  #255's whole point is where the filter *lives*. It used to live in the `InputBox`, which is a
 *  quick-pick-family widget: it hides the moment focus leaves, and clicking a tree row is the
 *  first thing anyone does with a filtered list — so the filter cleared itself before it could be
 *  used. The box is now an entry mechanism that reports changes and nothing more; the term lives
 *  here, and the rows' narrowing state lives (as it always did) in each view's own provider.
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
   *  views cannot drift into three naming conventions, which is how the filter came to mean
   *  three different things in the first place (#247). The literals still appear in
   *  `package.json`, its test, and the integration test's `EXPECTED_COMMANDS` — which is what
   *  catches a declared-but-unregistered command. The context key is deliberately not the record
   *  filter's `modbench.filterActive`: two independent axes, two keys. */
  viewId: string;
  placeholder: string;
  /** Applies the term to the view's provider, which is where the narrowing itself lives. The
   *  second argument is the Mods separator toggle; the other call sites ignore it. */
  setFilter: (text: string, toggleOn: boolean) => void;
  /** The Mods tree's group-by-separator option, or absent on views with no option to carry. */
  toggle?: { icon: string; label: string };
}

export interface NameFilter extends vscode.Disposable {
  /** Whatever else this view says about itself, which the readout composes around: the active
   *  profile on Mods, the record filter's source on the Plugins tree. The filter owns
   *  `view.description` outright — two writers would race, and the term has to appear beside
   *  the base rather than replace it. */
  setBaseDescription(text: string | undefined): void;
}

export function registerNameFilter(deps: NameFilterDeps): NameFilter {
  let term = '';
  let toggleOn = true;
  let base: string | undefined;

  /** The persistent chip #255 asks for, in the surface the platform already provides. The term
   *  reads first: it is the volatile fact the user just applied, and on the Plugins tree the base
   *  is the *other* filter axis, which the term is naturally read before. */
  const render = (): void => {
    const parts = [term && `"${term}"`, base].filter(Boolean);
    deps.view.description = parts.length > 0 ? parts.join(' · ') : undefined;
  };

  const apply = (text: string, nextToggleOn: boolean): void => {
    term = text;
    toggleOn = nextToggleOn;
    deps.setFilter(text, nextToggleOn);
    void vscode.commands.executeCommand('setContext', `${deps.viewId}.filterActive`, text !== '');
    render();
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
    // Dispose the widget, keep the filter. This one line is the whole of #255.
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
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}
