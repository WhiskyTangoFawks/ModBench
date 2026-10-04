import * as vscode from 'vscode';
import type { RecordSummary, MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

export interface RecordPickerDeps {
  meditClient: Pick<MEditClient, 'searchRecords'>;
  reporter: Pick<Reporter, 'shownOnSurface'>;
}

type PickItem = vscode.QuickPickItem & { formKey?: string };

// FormKeyLink and FormKeyCell show a resolved reference in this label, so a record is chosen and
// read back in the same words.
function toPickItem(r: RecordSummary): PickItem {
  return { label: r.editorId ? `${r.editorId} [${r.formKey}]` : r.formKey, formKey: r.formKey };
}

function failureItem(err: unknown): PickItem {
  return { label: '$(error) The search failed', detail: errorMessage(err), alwaysShow: true };
}

// A user can paste a whole "EditorID [FormKey]" label into a picker, where searching the literal
// would find nothing. The *first* bracketed segment wins: a VMAD object reference's trailing
// bracket is an alias index, not identity.
export function normalizeFormKeyQuery(query: string): string {
  const bracketed = /\[([^\]]*)\]/.exec(query)?.[1]?.trim();
  return bracketed || query;
}

// Seeded with the current reference so it is visible instead of an empty-query default; setting
// `.value` does not fire onDidChangeValue, so the seed is searched explicitly. A stale in-flight
// search is dropped by a sequence guard.
export async function pickRecord(
  deps: RecordPickerDeps, seed: string, validTypes: string[],
): Promise<string | null> {
  const quickPick = vscode.window.createQuickPick<PickItem>();
  quickPick.placeholder = 'Search EditorID, FormID or FormKey…';
  quickPick.value = seed;

  let seq = 0;
  const runSearch = async (query: string) => {
    const mySeq = ++seq;
    if (!query.trim()) { quickPick.items = []; return; }
    quickPick.busy = true;
    try {
      const { items } = await deps.meditClient.searchRecords(normalizeFormKeyQuery(query), validTypes);
      if (mySeq !== seq) return;
      const qpItems = items.map(toPickItem);
      quickPick.items = qpItems;
      // Normalized, because the seed is the composite the cell displays — comparing
      // the raw seed against a bare formKey would match only when the reference is unresolved.
      const seeded = qpItems.find(i => i.formKey === normalizeFormKeyQuery(seed));
      if (seeded) quickPick.activeItems = [seeded];
    } catch (err) {
      if (mySeq !== seq) return;
      quickPick.items = [failureItem(err)];
      deps.reporter.shownOnSurface('error', 'The record search failed.', errorMessage(err));
    } finally {
      if (mySeq === seq) quickPick.busy = false;
    }
  };

  void runSearch(seed);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  quickPick.onDidChangeValue(value => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!value.trim()) { quickPick.items = []; seq++; return; }
    debounceTimer = setTimeout(() => void runSearch(value), 200);
  });

  return new Promise<string | null>(resolve => {
    let accepted = false;
    quickPick.onDidAccept(() => {
      const formKey = quickPick.selectedItems[0]?.formKey;
      if (!formKey) return;
      accepted = true;
      quickPick.hide();
      resolve(formKey);
    });
    quickPick.onDidHide(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      quickPick.dispose();
      if (!accepted) resolve(null);
    });
    quickPick.show();
  });
}
