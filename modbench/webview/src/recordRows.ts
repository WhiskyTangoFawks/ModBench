import { isString } from '../../src/wire/messages';
import { copiedText, modelValue, readsAsFlags, shownValue } from './modelValue';
import { formKeyLabel } from './FormKeyLink';
import { elementsIn } from './presentation';
import { idleMembers } from './siblingsInUse';
import {
  arrayElementContext, arrayParentContext, cellContext, columnHasNode, declaresMember, defaultOf, editableCellContext,
  getAtPath, isArrayElementHop, offersArrayAdd, referenceContext, rootFieldOf, stringValueContext, variantFor, wirePath,
  type CellContext, type Column,
} from './recordUtils';
import type { FocusedCell, NavRow } from './gridNavigation';
import type {
  ColumnKey, CompareOverride, CompareResult, FieldDiff, FieldMetadata, FormKeyResolution, PathHop, PathSegment, TemplatedBy,
} from './types';
import type { ArrayParentContext } from '../../src/wire/messages';

export const RECORD_HEADER_ROW = 'Record Header';
export const FORM_ID_ROW = `${RECORD_HEADER_ROW}.FormID`;
// The document member a record's FormID is (editor.md, The record header, story 2).
export const FORM_ID_PATH: PathHop[] = [{ kind: 'member', name: 'FormKey' }];

export interface GridCell {
  context: CellContext;
}

export interface ValueCell extends GridCell {
  meta: FieldMetadata;
  holds: boolean;
  // The document's value, and the value the cell shows: a translated string's text.
  value: unknown;
  shown: unknown;
  editPath?: PathHop[];
  dropAddsTo?: ArrayParentContext;
  // What a cell the game fills from a template reads, its tooltip, and the template it copies and drags as (editor-fields.md, Templated fields).
  template?: { reading: string; tooltip: string; copyText: string; formKey: string };
}

interface RowBase {
  key: string;
  parent: string | null;
  depth: number;
  expandable: boolean;
  name: string;
  label: GridCell;
  cells: ReadonlyMap<ColumnKey, GridCell>;
}

export interface FieldRow extends RowBase {
  kind: 'field';
  diff: FieldDiff;
  meta: FieldMetadata;
  path: PathSegment[];
  rootField: string;
  elementOf: string | null;
  isLastElement?: (column: ColumnKey) => boolean;
  keyMembers?: readonly string[] | null;
  cells: ReadonlyMap<ColumnKey, ValueCell>;
}

interface FormIdRow extends RowBase {
  kind: 'formId';
  meta: FieldMetadata;
}

/** The row that holds a run of rows no copy changes (editor.md, Rows, story 6). */
export interface RunRow extends RowBase {
  kind: 'run';
  holds: readonly string[];
}

export type RecordRow = (RowBase & { kind: 'recordHeader' }) | FieldRow | FormIdRow | RunRow;

interface RowsInput {
  result: CompareResult;
  columns: readonly Column[];
  editableColumns: ReadonlySet<ColumnKey>;
  partialFormColumns: ReadonlySet<ColumnKey>;
  // A copy's record as the panel names it, which a string cell's own tab is filed under.
  recordLabel: (copy: CompareOverride) => string;
}

type RowPlacement = Pick<FieldRow, 'path' | 'rootField' | 'key' | 'parent' | 'depth' | 'isLastElement' | 'keyMembers'> & {
  // Whether a column holds the object this row is a member of.
  present: (column: ColumnKey) => boolean;
  editable: ReadonlySet<ColumnKey>;
  // Per column, the variant a member whose type varies by its owner's leaf takes there.
  cellMetas?: Partial<Record<string, FieldMetadata>>;
};

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

function templateOf(
  copy: CompareOverride, rootField: string, path: readonly PathSegment[],
): { by: TemplatedBy; isMembersRow: boolean } | undefined {
  const templated = copy.templated;
  if (!templated) return undefined;
  let member = rootField;
  for (let depth = 0; ; depth++) {
    const by = templated[member];
    if (by) return { by, isMembersRow: depth === path.length };
    const seg = path[depth];
    if (seg?.kind !== 'member') return undefined;
    member = `${member}.${seg.name}`;
  }
}

const resolves = (resolution: FormKeyResolution | undefined): resolution is FormKeyResolution =>
  resolution !== undefined && resolution.state !== 'Unresolved';

function goToTarget(
  templatedBy: TemplatedBy | undefined, shown: unknown, meta: FieldMetadata, resolution: FormKeyResolution | undefined,
): string | undefined {
  if (templatedBy) return resolves(templatedBy.resolution) ? templatedBy.template : undefined;
  return isString(shown) && meta.type === 'formKey' && resolves(resolution) ? shown : undefined;
}

function templateReading(template: TemplatedBy, ownValue: string | undefined, editable: boolean): NonNullable<ValueCell['template']> {
  const copyText = formKeyLabel(template.template, template.resolution);
  return {
    reading: `from ${template.resolution.editorId || template.template}`,
    copyText,
    formKey: template.template,
    tooltip: [
      `Templated by ${template.flag} from ${copyText}`,
      ...(ownValue === undefined ? [] : [`Its own value: ${ownValue}`]),
      ...(editable ? [`Clearing ${template.flag} makes it editable.`] : []),
    ].join('\n'),
  };
}

function fieldRow(
  diff: FieldDiff, meta: FieldMetadata, at: RowPlacement, columns: readonly Column[], recordLabel: RowsInput['recordLabel'],
  stringsLanguage: string,
): FieldRow {
  const { present, editable, cellMetas, ...place } = at;
  const name = meta.displayLabel ?? diff.fieldName;
  const last = at.path.at(-1);
  const elementOf = isArrayElementHop(last) ? at.parent : null;
  // A row no column carries a value for holds nothing but its children, so every column holds it.
  const structural = Object.values(diff.values).every(v => v == null);
  const cells = new Map(columns.map(({ key, override: o }): [ColumnKey, ValueCell] => {
    const cellMeta = cellMetas?.[key] ?? meta;
    const value = diff.values[key];
    const holds = structural || (present(key) && columnHasNode(cellMeta, value));
    const held = holds ? value ?? defaultOf(cellMeta) : undefined;
    const shown = holds ? shownValue(held, cellMeta, stringsLanguage) : undefined;
    const resolution = diff.resolutions?.[key];
    const templated = templateOf(o, at.rootField, at.path);
    const templatedBy = templated && (holds || templated.isMembersRow) ? templated.by : undefined;
    const template = templatedBy && templateReading(templatedBy, holds ? copiedText(shown, cellMeta, resolution) : undefined, editable.has(key));
    const goesTo = goToTarget(templatedBy, shown, cellMeta, resolution);
    const hops = wirePath(at.rootField, at.path, key);
    const editPath = hops && editable.has(key) && cellMeta.readOnlyReason == null ? hops : undefined;
    const dropAddsTo = editPath && !template && offersArrayAdd(meta) ? arrayParentContext(o.formKey, o.plugin, o.origin, editPath) : undefined;
    const element = editPath && !template && isArrayElementHop(last)
      ? arrayElementContext(
        o.formKey, o.plugin, o.origin, editPath, arrayLength(getAtPath(rootFieldOf(o, at.rootField)?.value, editPath.slice(1, -1))),
        last?.kind === 'element' && last.keyed)
      : undefined;
    const context = cellContext(
      template?.copyText ?? copiedText(shown, cellMeta, resolution),
      dropAddsTo,
      element,
      editPath && editableCellContext(o.formKey, o.plugin, o.origin, editPath, value != null),
      hops && meta.type === 'string'
        ? stringValueContext(o.formKey, o.plugin, o.origin, recordLabel(o), name, modelValue(value, meta), !editPath, hops)
        : undefined,
      goesTo === undefined ? undefined : referenceContext(goesTo),
    );
    return [key, { context, meta: cellMeta, holds, value: held, shown, editPath, dropAddsTo, template }];
  }));
  return {
    kind: 'field', diff, meta, ...place, expandable: (diff.children?.length ?? 0) > 0 || readsAsFlags(meta),
    name, elementOf, label: { context: cellContext(name) }, cells,
  };
}

// Two elements sharing a key share a label, and each is a row of its own.
function withRowKeys(parent: string, children: readonly FieldDiff[]): [FieldDiff, string][] {
  const turns = new Map<string, number>();
  return children.map(child => {
    const turn = (turns.get(child.fieldName) ?? 0) + 1;
    turns.set(child.fieldName, turn);
    return [child, turn === 1 ? `${parent}.${child.fieldName}` : `${parent}.${child.fieldName}#${turn}`];
  });
}

// A diff node naming a member no override's
// schema declares has no shape to render against, so it and its subtree have no rows.
export function recordRows({ result, columns, editableColumns, partialFormColumns, recordLabel }: RowsInput): RecordRow[] {
  const metaByName: Partial<Record<string, FieldMetadata>> = {};
  for (const o of result.overrides) {
    for (const fv of o.fields) metaByName[fv.metadata.name] ??= fv.metadata;
  }
  const ownFieldEditableColumns = new Set([...editableColumns].filter(key => !partialFormColumns.has(key)));

  function rowsOf(diff: FieldDiff, meta: FieldMetadata | undefined, at: RowPlacement): RecordRow[] {
    if (!meta) return [];
    const children = diff.children ?? [];
    const rows: RecordRow[] = [fieldRow(diff, meta, at, columns, recordLabel, result.stringsLanguage)];
    const { path, key, present, depth } = at;

    // Mutagen aliases a condition's parameter slots onto the same bytes, so the idle twin of a
    // live slot would render the same four bytes a second time as a different type. Filtering
    // removes only rows the diff already has.
    const idle = meta.type === 'struct' ? idleMembers(meta, columns.map(c => diff.values[c.key])) : undefined;

    for (const [child, childKey] of withRowKeys(key, children)) {
      if (idle?.has(child.fieldName)) continue;
      if (meta.type === 'array' && meta.elementType) {
        rows.push(...rowsOf(child, meta.elementType, {
          ...at,
          path: [...path, { kind: 'element', indexes: child.indexes, keyed: !!meta.keyMembers }],
          key: childKey, parent: key, present: column => child.values[column] != null, depth: depth + 1,
          isLastElement: column => elementsIn(diff, column).at(-1) === child,
          keyMembers: meta.keyMembers,
          cellMetas: undefined,
        }));
      } else if (meta.type === 'struct') {
        // mEdit sends a union member's children from its winner column's leaf, so the row takes
        // its structure from that leaf, and each cell the shape its own column's leaf gives it.
        const member = meta.fields?.find(f => f.name === child.fieldName);
        const memberMeta = member && variantFor(member, diff.values[child.winnerColumn], meta);
        const cellMetas = member?.variants
          ? Object.fromEntries(columns.map(c => [c.key, variantFor(member, diff.values[c.key], meta)]))
          : undefined;
        rows.push(...rowsOf(child, memberMeta, {
          ...at,
          path: [...path, { kind: 'member', name: child.fieldName }],
          key: childKey, parent: key,
          present: column => present(column) && columnHasNode(meta, diff.values[column])
            && (!member || declaresMember(member, diff.values[column], meta)),
          depth: depth + 1, isLastElement: undefined, keyMembers: undefined, cellMetas,
        }));
      }
    }
    return rows;
  }

  const cellsCopying = (text: (column: Column) => string | undefined) =>
    new Map(columns.map(column => [column.key, { context: cellContext(text(column)) }]));
  const recordHeader: RecordRow = {
    kind: 'recordHeader', key: RECORD_HEADER_ROW, parent: null, depth: 0, expandable: true,
    name: RECORD_HEADER_ROW, label: { context: cellContext(RECORD_HEADER_ROW) }, cells: cellsCopying(() => undefined),
  };
  const isHeaderMember = (diff: FieldDiff) => metaByName[diff.fieldName]?.isRecordHeaderMember === true;
  const headerRows = result.diffs.filter(isHeaderMember).flatMap((diff): RecordRow[] => {
    const meta = metaByName[diff.fieldName];
    return meta?.isRecordFormKey
      ? [{
        kind: 'formId', key: FORM_ID_ROW, parent: RECORD_HEADER_ROW, depth: 1, expandable: false, meta,
        name: meta.displayLabel ?? meta.name, label: { context: cellContext(meta.displayLabel ?? meta.name) },
        cells: cellsCopying(({ override }) => formKeyLabel(override.formKey, override)),
      }]
      : rowsOf(diff, meta, {
        path: [], rootField: diff.fieldName, key: `${RECORD_HEADER_ROW}.${diff.fieldName}`, parent: RECORD_HEADER_ROW,
        present: () => true, editable: editableColumns, depth: 1,
      });
  });
  // A Partial Form column's own fields are nulled by the classifier: none is absent by default,
  // since the record's own fields are not there to be members of.
  const fieldRows = result.diffs.filter(d => !isHeaderMember(d)).flatMap(diff => {
    const meta = metaByName[diff.fieldName];
    const isEditorId = meta?.isEditorId === true;
    return rowsOf(diff, meta, {
      path: [], rootField: diff.fieldName, key: diff.fieldName, parent: null,
      present: column => isEditorId || !partialFormColumns.has(column),
      editable: isEditorId ? editableColumns : ownFieldEditableColumns, depth: 0,
    });
  });
  return [recordHeader, ...headerRows, ...fieldRows];
}

export function visibleRows(rows: readonly RecordRow[], collapsed: ReadonlySet<string>): RecordRow[] {
  const hidden = new Set<string>();
  return rows.filter(row => {
    const under = row.parent !== null && (collapsed.has(row.parent) || hidden.has(row.parent));
    if (under) hidden.add(row.key);
    return !under;
  });
}

/** The cell `at` names as the grid shows it: none while its row or column is collapsed away, or its
 *  row is gone. */
export function shownCell(
  rows: readonly RecordRow[], collapsedRows: ReadonlySet<string>, collapsedColumns: ReadonlySet<ColumnKey>, at: FocusedCell,
): GridCell | ValueCell | undefined {
  if (at.plugin !== null && collapsedColumns.has(at.plugin)) return undefined;
  const row = visibleRows(rows, collapsedRows).find(r => r.key === at.rowKey);
  return at.plugin === null ? row?.label : row?.cells.get(at.plugin);
}

export function navRows(rows: readonly RecordRow[], collapsed: ReadonlySet<string>): NavRow[] {
  return visibleRows(rows, collapsed).map(row => ({
    key: row.key, parent: row.parent, expandable: row.expandable, expanded: row.kind !== 'run' && !collapsed.has(row.key),
  }));
}
