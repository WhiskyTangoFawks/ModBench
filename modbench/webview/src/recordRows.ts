import { readsAsFlags } from './modelValue';
import { elementsIn } from './presentation';
import { idleMembers } from './siblingsInUse';
import { columnHasNode, declaresMember, variantFor, type Column, type PathSegment } from './recordUtils';
import type { NavRow } from './gridNavigation';
import type { ColumnKey, CompareResult, FieldDiff, FieldMetadata, PathHop } from './types';

export const RECORD_HEADER_ROW = 'Record Header';
export const FORM_ID_ROW = `${RECORD_HEADER_ROW}.FormID`;
// The document member a record's FormID is (editor.md, The record header, story 2).
export const FORM_ID_PATH: PathHop[] = [{ kind: 'member', name: 'FormKey' }];

interface RowBase {
  key: string;
  parent: string | null;
  depth: number;
  expandable: boolean;
}

// `present` says which columns carry the object a row is a member of, and `editable` which columns
// can write it.
export interface FieldRow extends RowBase {
  kind: 'field';
  diff: FieldDiff;
  meta: FieldMetadata;
  path: PathSegment[];
  rootField: string;
  present: (column: ColumnKey) => boolean;
  editable: ReadonlySet<ColumnKey>;
  isLastElement?: (column: ColumnKey) => boolean;
  keyMembers?: readonly string[] | null;
  cellMetas?: Partial<Record<string, FieldMetadata>>;
}

export interface FormIdRow extends RowBase {
  kind: 'formId';
  meta: FieldMetadata;
}

export type RecordRow = FieldRow | FormIdRow;

export interface RowsInput {
  result: CompareResult;
  columns: readonly Column[];
  editableColumns: ReadonlySet<ColumnKey>;
  partialFormColumns: ReadonlySet<ColumnKey>;
}

type Placement = Pick<FieldRow, 'path' | 'rootField' | 'key' | 'parent' | 'present' | 'editable' | 'depth'>
  & Partial<Pick<FieldRow, 'isLastElement' | 'keyMembers' | 'cellMetas'>>;

// Two elements sharing a key share a label, and each is a row of its own.
function withRowKeys(parent: string, children: readonly FieldDiff[]): [FieldDiff, string][] {
  const turns = new Map<string, number>();
  return children.map(child => {
    const turn = (turns.get(child.fieldName) ?? 0) + 1;
    turns.set(child.fieldName, turn);
    return [child, turn === 1 ? `${parent}.${child.fieldName}` : `${parent}.${child.fieldName}#${turn}`];
  });
}

// Every row, expanded, in the order the grid shows them. A diff node naming a member no override's
// schema declares has no shape to render against, so it and its subtree have no rows.
export function recordRows({ result, columns, editableColumns, partialFormColumns }: RowsInput): RecordRow[] {
  const metaByName: Partial<Record<string, FieldMetadata>> = {};
  for (const o of result.overrides) {
    for (const fv of o.fields) metaByName[fv.metadata.name] ??= fv.metadata;
  }
  const ownFieldEditableColumns = new Set([...editableColumns].filter(key => !partialFormColumns.has(key)));

  function rowsOf(diff: FieldDiff, meta: FieldMetadata | undefined, at: Placement): RecordRow[] {
    if (!meta) return [];
    const children = diff.children ?? [];
    const rows: RecordRow[] = [{
      kind: 'field', diff, meta, ...at, expandable: children.length > 0 || readsAsFlags(meta),
    }];
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
        // A union member's shape is the leaf's the row's own values name; the row takes the first
        // column's leaf for its structure, and each cell the shape its own column's leaf gives it.
        const member = meta.fields?.find(f => f.name === child.fieldName);
        const owner = columns.map(c => diff.values[c.key]).find(v => v != null);
        const memberMeta = member && variantFor(member, owner, meta);
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

  const isHeaderMember = (diff: FieldDiff) => metaByName[diff.fieldName]?.isRecordHeaderMember === true;
  const headerRows = result.diffs.filter(isHeaderMember).flatMap((diff): RecordRow[] => {
    const meta = metaByName[diff.fieldName];
    return meta?.isRecordFormKey
      ? [{ kind: 'formId', key: FORM_ID_ROW, parent: RECORD_HEADER_ROW, depth: 1, expandable: false, meta }]
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
  return [...headerRows, ...fieldRows];
}

// The rows under no collapsed row, the Record Header's own members included.
export function visibleRows(rows: readonly RecordRow[], collapsed: ReadonlySet<string>): RecordRow[] {
  const hidden = new Set<string>();
  return rows.filter(row => {
    const under = row.parent !== null && (collapsed.has(row.parent) || hidden.has(row.parent));
    if (under) hidden.add(row.key);
    return !under;
  });
}

export function navRows(rows: readonly RecordRow[], collapsed: ReadonlySet<string>): NavRow[] {
  return [
    { key: RECORD_HEADER_ROW, parent: null, expandable: true, expanded: !collapsed.has(RECORD_HEADER_ROW) },
    ...visibleRows(rows, collapsed).map(row => ({
      key: row.key, parent: row.parent, expandable: row.expandable, expanded: !collapsed.has(row.key),
    })),
  ];
}
