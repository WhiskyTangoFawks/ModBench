import { z } from 'zod';
import type { CopyDocument, MEditClient } from '../client/MEditClient';
import { pluginAddressOf, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { copyColumnKey } from '../wire/columnKey';
import type { CompareResult } from '../client';
import { holdsNoCopy, type RecordCopy } from '../wire/recordCopy';
import type { InstanceValue } from '../instanceLoader/instance';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { Refusal } from '../drivingLib/refusal';
import { renderedCopy } from '../drivingLib/renderedCopy';
import { pluginsNamed } from './names';
import { formKeysNamed } from './recordNames';

const RECORD = {
  name: z.string(),
  plugin: z.object({ name: z.string(), origin: z.string().optional() }).optional(),
};

type RecordReads = Pick<MEditClient, 'resolveNames' | 'getComparison' | 'getCopyDocument' | 'getRenderedDocument'>;

const copyOf = async (
  mEdit: RecordReads, copy: RecordCopy,
): Promise<CopyDocument | { kind: 'Rendered'; text: string } | { refused: string }> => {
  const document = await mEdit.getCopyDocument(copy.plugin, copy.formKey);
  if (isReadFailed(document)) return { refused: failureReason(document) };
  if (document === null) return { refused: holdsNoCopy(copy) };
  if (document.kind !== 'Rendered') return document;
  const rendered = await renderedCopy(mEdit, copy);
  return 'refused' in rendered ? rendered : { kind: document.kind, text: rendered.text };
};

type CompareOverride = CompareResult['overrides'][number];
type FieldDiff = CompareResult['diffs'][number];

interface ConflictRow {
  readonly field: string;
  readonly conflictAll: FieldDiff['conflictAll'];
  readonly conflictThis?: FieldDiff['cellStates'][string];
  readonly children?: readonly ConflictRow[];
}

const rowsOf = (diffs: readonly FieldDiff[], column: string): ConflictRow[] => diffs.map((diff) => ({
  field: diff.fieldName,
  conflictAll: diff.conflictAll,
  ...(diff.cellStates[column] !== undefined && { conflictThis: diff.cellStates[column] }),

  ...(diff.children != null && diff.children.length > 0 && { children: rowsOf(diff.children, column) }),
}));

const standingOf = (copy: CompareOverride, { diffs }: CompareResult) => ({
  loadIndex: copy.loadIndex,
  isPartialForm: copy.isPartialForm,
  ...(copy.parseDiagnosis != null && { parseDiagnosis: copy.parseDiagnosis }),
  ...(copy.conflictThis != null && { conflictThis: copy.conflictThis }),
  fields: rowsOf(diffs, copyColumnKey(copy)),
});

const standingIn = async (mEdit: RecordReads, formKey: string, address: PluginAddress) => {
  const comparison = await mEdit.getComparison(formKey);
  if (isReadFailed(comparison)) throw new Refusal(failureReason(comparison));
  const compared = comparison?.overrides.find((o) => samePluginAddress(pluginAddressOf(o), address));
  return comparison === null || compared === undefined ? {} : standingOf(compared, comparison);
};

export const READ_RECORD = {
  name: 'read_record',
  description: 'A record in the load order, by its EditorID or FormKey: each active plugin\'s copy, as below, as { plugin: { name, origin }, isWinner, loadIndex, isPartialForm, parseDiagnosis?, conflictThis?, fields, ...copy }, or { plugin, isWinner, reason } for a copy that could not be read, which refuses the read in part. '
    + 'loadIndex is the plugin\'s load index as the record panel writes it, isPartialForm is a copy the game ignores the fields of, parseDiagnosis is why mEdit could not read the copy, conflictThis is the copy\'s worst cell state, '
    + 'and fields are the record panel\'s rows, each { field, conflictAll, conflictThis?, children? }: conflictAll is the row across every copy, and conflictThis the cell of this copy. '
    + 'With plugin { name, origin? } as list_plugins shows it, that plugin\'s copy alone, whether the plugin is active or not, with the same standing when the plugin is compared. '
    + 'A copy is { kind: \'OwnFile\' | \'ContainersFile\', location } the path of the source file that holds it, or { kind: \'Rendered\', text } the copy\'s text, for a plugin with no source.',
  input: RECORD,
  of: async (
    mEdit: RecordReads,
    value: InstanceValue,
    { name, plugin }: { name: string; plugin?: { name: string; origin?: string } },
  ) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const [address] = plugin === undefined ? [] : pluginsNamed(value, [plugin]);
    if (address !== undefined) {
      const copy = await copyOf(mEdit, { formKey, plugin: address });
      if ('refused' in copy) throw new Refusal(copy.refused);
      return { ...(await standingIn(mEdit, formKey, address)), ...copy };
    }
    const comparison = await mEdit.getComparison(formKey);
    if (isReadFailed(comparison)) throw new Refusal(failureReason(comparison));
    if (comparison === null) throw new Refusal(`No active plugin holds ${formKey}.`);
    const entries = await Promise.all(comparison.overrides.map(async (compared) => {
      const { isWinner } = compared;
      const copyAddress = pluginAddressOf(compared);
      const copy = await copyOf(mEdit, { formKey, plugin: copyAddress });
      return 'refused' in copy ? { plugin: copyAddress, isWinner, reason: copy.refused } : { plugin: copyAddress, isWinner, ...standingOf(compared, comparison), ...copy };
    }));
    const reasons = entries.flatMap((entry) => ('reason' in entry ? [entry.reason] : []));
    if (reasons.length > 0) throw new Refusal(reasons.join(' '), entries);
    return entries;
  },
};

export const LIST_REFERENCES = {
  name: 'list_references',
  description: 'The records that reference a record, by its EditorID or FormKey.',
  input: { name: z.string() },
  of: async (mEdit: Pick<MEditClient, 'resolveNames' | 'getReferences'>, { name }: { name: string }) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const referrers = await mEdit.getReferences(formKey);
    if (isReadFailed(referrers)) throw new Refusal(failureReason(referrers));
    return referrers;
  },
};
