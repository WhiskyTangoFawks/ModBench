import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The temp directory every extended-editor tab writes under. */
export const EXTENDED_FIELD_TEMP_ROOT = join(tmpdir(), 'modbench-medit-fields');

// Any segment may carry a FormKey's `:` or characters Windows paths reject. Collapsed whitespace
// and a length cap keep the result one sane segment; `|| '_'` guards a segment that sanitizes
// down to nothing.
function sanitizeForPath(segment: string): string {
  return segment
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '_';
}

/** Deterministic per record, field and plugin copy, so re-opening the same cell reveals the same
 *  tab. `origin` is its own directory segment: two columns can share a filename and would
 *  otherwise alias onto one temp file (ADR-0012). */
export function extendedFieldFile(
  tempRoot: string, field: { recordLabel: string; fieldName: string; plugin: string; origin: string },
): { folder: string; file: string } {
  const folder = join(tempRoot, sanitizeForPath(field.recordLabel), sanitizeForPath(field.origin));
  return { folder, file: join(folder, `${sanitizeForPath(field.fieldName)} [${sanitizeForPath(field.plugin)}].txt`) };
}
