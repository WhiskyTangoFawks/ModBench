// commands.md, compile: Editor, on a tracked and editable plugin. What the record tab's compile
// button reads, asked again whenever the open record or the plugin facts change.

interface Disposable { dispose(): void }

export interface OpenRecordCompilableDeps {
  onDidChangeOpenRecord: (listener: (formKey: string | undefined) => void) => Disposable;
  openRecord: () => string | undefined;
  onDidChangeFacts: (listener: () => void) => Disposable;
  ownerOf: (formKey: string) => Promise<{ plugin: string; origin: string } | undefined>;
  compilable: (plugin: string, origin: string) => boolean;
  show: (compilable: boolean) => void;
}

export function showOpenRecordCompilable(deps: OpenRecordCompilableDeps): Disposable {
  let asked = 0;
  const ask = async (): Promise<void> => {
    const question = ++asked;
    const formKey = deps.openRecord();
    const owner = formKey === undefined ? undefined : await deps.ownerOf(formKey).catch(() => undefined);
    if (question !== asked) return;
    deps.show(owner !== undefined && deps.compilable(owner.plugin, owner.origin));
  };
  const subscriptions = [
    deps.onDidChangeOpenRecord(() => { void ask(); }),
    deps.onDidChangeFacts(() => { void ask(); }),
  ];
  void ask();
  return { dispose: () => { for (const s of subscriptions) s.dispose(); } };
}
