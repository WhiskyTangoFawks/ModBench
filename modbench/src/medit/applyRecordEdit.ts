import type { Reporter } from '../modmanager/deployer';
import type { PluginRepository } from './PluginRepository';
import type { RecordEditEnvelope } from './messages';

/** What any record-panel gesture needs to write, whichever surface it arrives from — the webview's
 *  inline and keyboard edits through the message router, the right-click menus straight from the
 *  command they invoke. */
export interface RecordWriteDeps {
  // ADR-0041: the single write path. Injected rather than imported so this stays callable from a
  // plain unit test.
  repository: Pick<PluginRepository, 'editRecord'>;
  // plugin/origin ride along because a FormKey names a record, not which plugin's copy of it this
  // edit landed on.
  onRecordEdited: (formKey: string, plugin: string, origin: string) => void;
  reporter: Reporter;
}

/** An edit travels through the extension host rather than straight to the backend because a
 *  refusal has to become a native notification (ADR-0026), a surface only the host has. A refusal
 *  is a warning, a transport failure an error. */
export async function applyRecordEdit(
  deps: RecordWriteDeps, formKey: string, plugin: string, origin: string, envelope: RecordEditEnvelope,
): Promise<void> {
  try {
    const outcome = await deps.repository.editRecord(formKey, plugin, origin, envelope);
    if (outcome.applied) {
      deps.onRecordEdited(formKey, plugin, origin);
      return;
    }
    deps.reporter.report('warning', outcome.message);
  } catch (err) {
    deps.reporter.report(
      'error', 'Could not edit this record.', err instanceof Error ? err.message : String(err));
  }
}
