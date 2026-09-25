/** A tab showing a record whose FormID changed goes with it to the new FormKey, and reads it there
 *  once mEdit reports the change (ADR-0015, invariant 3). */
export function followRecordInPanels<Panel extends { title: string }>(
  recordPanels: Iterable<Panel>,
  activeRecordTracker: { formKeyOf(panel: Panel): string | undefined; setFormKey(panel: Panel, formKey: string): void },
  formKey: string,
  newFormKey: string,
): void {
  for (const panel of recordPanels) {
    if (activeRecordTracker.formKeyOf(panel) !== formKey) continue;
    activeRecordTracker.setFormKey(panel, newFormKey);
    if (panel.title === formKey) panel.title = newFormKey;
  }
}
