import type { Reporter } from '../ports/reporter';
import type { MEditClient, RecordEditEnvelope } from '../client';
import { errorMessage } from '../ports/errorMessage';

/** What any record-panel gesture needs to write, whichever surface it arrives from — the webview's
 *  inline and keyboard edits through the message router, the right-click menus straight from the
 *  command they invoke. */
export interface RecordWriteDeps {
  // ADR-0007: the single write path, the port's own verb. Injected rather than imported so this
  // stays callable from a plain unit test.
  meditClient: Pick<MEditClient, 'editRecord'>;
  // plugin/origin ride along because a FormKey names a record, not which plugin's copy of it this
  // edit landed on.
  onRecordEdited: (formKey: string, plugin: string, origin: string) => void;
  reporter: Reporter;
}

/** An edit goes through the extension host because a refusal becomes a native notification
 *  (ADR-0019): a refusal a warning, a transport failure an error. Resolves the new FormKey an edit
 *  of the FormID landed under. */
export async function applyRecordEdit(
  deps: RecordWriteDeps, formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope,
): Promise<string | undefined> {
  try {
    const outcome = await deps.meditClient.editRecord(formKey, plugin, origin, envelope);
    if (outcome.applied) {
      deps.onRecordEdited(formKey, plugin, origin);
      return outcome.newFormKey;
    }
    deps.reporter.report('warning', outcome.message);
  } catch (err) {
    deps.reporter.report(
      'error', 'Could not edit this record.', errorMessage(err));
  }
}
