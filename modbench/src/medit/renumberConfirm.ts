import type { components } from './generated/api';

type ReferenceResult = components['schemas']['ReferenceResult'];

/** #572 ruling 3: a legal renumber cascades automatically behind one up-front confirm stating the
 *  blast radius. Null when nothing references the record — the simple rename needs no confirm
 *  (#427's existing behavior). Rows are one-per-(record, field), so referencing records dedupe by
 *  FormKey and plugins case-insensitively (a filename is not case-significant on any Bethesda
 *  platform). */
export function renumberConfirmMessage(
  oldFormKey: string, newFormKey: string, references: ReferenceResult[],
): string | null {
  if (references.length === 0) return null;
  const records = new Set(references.map((r) => r.formKey)).size;
  const plugins = new Set(references.map((r) => r.plugin.toLowerCase())).size;
  return `Change FormID of ${oldFormKey} to ${newFormKey}? ` +
    `This also updates ${records} referencing record(s) across ${plugins} plugin(s), ` +
    'all landing together as reviewable working-tree changes.';
}
