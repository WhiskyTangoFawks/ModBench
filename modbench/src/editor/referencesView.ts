import * as vscode from 'vscode';
import type { ReferencedByList } from './referencedByList';

const REFERENCES_VIEW_EXTENSION = 'vscode.references-view';

// The slice of the built-in extension's exports Referenced By drives; @types/vscode does not declare it.
export interface ReferencesViewInput {
  readonly title: string;
  // The view opens this as a text document and clears itself unless a non-blank run sits at its start.
  readonly location: vscode.Location;
  // The view sets `reference-list.source` to it.
  readonly contextValue: string;
  resolve(): Promise<ReferencedByList>;
  // Its refresh calls this when the document moved the anchor since the list was asked for.
  with(location: vscode.Location): ReferencesViewInput;
}

interface ReferencesView {
  setInput(input: ReferencesViewInput): void;
}

/** VS Code's References view; none while its built-in extension is disabled. */
export async function referencesView(): Promise<ReferencesView | undefined> {
  return vscode.extensions.getExtension<ReferencesView>(REFERENCES_VIEW_EXTENSION)?.activate();
}

/** Keeps `modbench.referencesView` true while the view is enabled, for the menus that offer Referenced By. */
export function publishReferencesView(setContext: (key: string, value: unknown) => void): vscode.Disposable {
  const publish = (): void => { setContext('modbench.referencesView', vscode.extensions.getExtension(REFERENCES_VIEW_EXTENSION) !== undefined); };
  publish();
  return vscode.extensions.onDidChange(publish);
}
