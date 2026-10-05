import type { Reporter } from '../ports/reporter';
import type { MEditClient, RecordEditEnvelope } from '../client';
import type { PathHop } from '../wire/messages';
import { errorMessage } from '../ports/errorMessage';

/** What any record-panel gesture needs to write, whichever surface it arrives from — the webview's
 *  inline and keyboard edits through the message router, the right-click menus straight from the
 *  command they invoke. */
export interface RecordWriteDeps {
  // Injected rather than imported so this stays callable from a plain unit test.
  meditClient: Pick<MEditClient, 'editRecord'>;
  // The native Source Control panel does not pick up a field edit's working-tree change on its own.
  // The records and their badges are not the edit's to touch: they follow mEdit's changed rows.
  refreshSourceControlFor: (plugin: string, origin: string) => void;
  reporter: Reporter;
}

function spellField(path: PathHop[]): string {
  return path.map((hop, i) => hop.kind === 'index' ? `[${hop.index}]` : i === 0 ? hop.name : `.${hop.name}`).join('');
}

/** An edit goes through the extension host because a refusal becomes a native notification
 *  (editor.md, Reporting, story 1). Resolves the new FormKey an edit of the FormID landed under. */
export async function applyRecordEdit(
  deps: RecordWriteDeps, formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope,
): Promise<string | undefined> {
  const field = spellField(envelope.path);
  try {
    const outcome = await deps.meditClient.editRecord(formKey, { name: plugin, origin }, envelope);
    if (outcome.applied) {
      deps.refreshSourceControlFor(plugin, origin);
      return outcome.newFormKey;
    }
    deps.reporter.report('warning', `${field}: ${outcome.message}`);
  } catch (err) {
    deps.reporter.report(
      'error', `Could not edit ${field}.`, errorMessage(err));
    return undefined;
  }
}
