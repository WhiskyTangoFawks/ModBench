/** What a landed field edit does itself. The records and their badges are not its to touch:
 *  they follow mEdit's changed rows (ADR-0015 invariant 2). */
export function makeOnRecordEdited(
  refreshSourceControl: (plugin: string, origin: string) => void,
): (formKey: string, plugin: string, origin: string) => void {
  return (_formKey, plugin, origin) => {
    refreshSourceControl(plugin, origin);
  };
}
