import { z } from 'zod';
import type { CopyDocument, MEditClient } from '../client/MEditClient';
import { pluginAddressOf, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { copyColumnKey } from '../wire/columnKey';
import { fileStanding } from '../drivingLib/fileStanding';
import { copyStatus, NO_STANDING, pluginOf, type Standing } from '../drivingLib/columnStatus';
import { withMasterCellStates } from '../drivingLib/masterCellStates';
import { pluginStanding } from '../instanceLoader/pluginStanding';
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
  plugin: z.strictObject({ name: z.string(), origin: z.string().optional() }).optional(),
};

type RecordReads = Pick<MEditClient, 'resolveNames' | 'getComparison' | 'getPlugins' | 'getCopyDocument' | 'getRenderedDocument'>;

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

type Plugins = Extract<Awaited<ReturnType<RecordReads['getPlugins']>>, readonly unknown[]>;

const standingOf = (plugins: Plugins, comparison: CompareResult, copy: CompareOverride, standing: Standing) => {
  const status = copyStatus(copy, pluginOf(plugins, copy), standing);
  return {
    loadIndex: copy.loadIndex,
    ...(status !== null && { status }),
    isPartialForm: copy.isPartialForm,
    ...(copy.parseDiagnosis != null && { parseDiagnosis: copy.parseDiagnosis }),
    ...(copy.conflictThis != null && { conflictThis: copy.conflictThis }),
    fields: rowsOf(comparison.diffs, copyColumnKey(copy)),
  };
};

const pluginsRead = async (mEdit: RecordReads): Promise<Plugins> => {
  const plugins = await mEdit.getPlugins();
  if (isReadFailed(plugins)) throw new Refusal(failureReason(plugins));
  return plugins;
};

const standingIn = async (mEdit: RecordReads, value: InstanceValue, formKey: string, address: PluginAddress) => {
  const comparison = await mEdit.getComparison(formKey);
  if (isReadFailed(comparison)) throw new Refusal(failureReason(comparison));
  const plugins = await pluginsRead(mEdit);
  const standing = fileStanding({
    pluginActive: plugins.some((p) => p.inLoadOrder && samePluginAddress(p, address)),
    columnsShown: false,
    standing: pluginStanding(value, address),
  });
  const compared = comparison?.overrides.find((o) => samePluginAddress(pluginAddressOf(o), address));
  if (comparison !== null && compared !== undefined) return standingOf(plugins, withMasterCellStates(comparison), compared, standing);
  const status = standing.overriddenBy !== null || standing.notActive
    ? copyStatus({ plugin: address.name, origin: address.origin, isPartialForm: false, isInOverwrite: false }, undefined, standing)
    : null;
  return status === null ? {} : { status };
};

export const READ_RECORD = {
  name: 'read_record',
  description: 'A record in the load order, by its EditorID or FormKey: each active plugin\'s copy, as below, as { plugin: { name, origin }, isWinner, loadIndex, status?, isPartialForm, parseDiagnosis?, conflictThis?, fields, ...copy }, or { plugin, isWinner, reason } for a copy that could not be read, which refuses the read in part. '
    + 'loadIndex is the plugin\'s load index as the record panel writes it, status is { label, reason } as the record panel\'s column header shows it, and absent for a copy the game uses and I can edit, isPartialForm is a copy the game ignores the fields of, parseDiagnosis is why mEdit could not read the copy, conflictThis is the copy\'s worst cell state, '
    + 'and fields are the record panel\'s rows, each { field, conflictAll, conflictThis?, children? }: conflictAll is the row across every copy, and conflictThis the cell of this copy. '
    + 'With plugin { name, origin? } as list_plugins shows it, that plugin\'s copy alone, whether the plugin is active or not, with the same standing when the plugin is compared; only this one, the file asked for, takes the instance\'s word that the game loads it or loads another mod\'s file instead, as the panel gives that to the tab\'s own column alone. '
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
      return { ...(await standingIn(mEdit, value, formKey, address)), ...copy };
    }
    const compared = await mEdit.getComparison(formKey);
    if (isReadFailed(compared)) throw new Refusal(failureReason(compared));
    if (compared === null) throw new Refusal(`No active plugin holds ${formKey}.`);
    const comparison = withMasterCellStates(compared);
    const plugins = await pluginsRead(mEdit);
    const entries = await Promise.all(comparison.overrides.map(async (copied) => {
      const { isWinner } = copied;
      const copyAddress = pluginAddressOf(copied);
      const copy = await copyOf(mEdit, { formKey, plugin: copyAddress });
      return 'refused' in copy ? { plugin: copyAddress, isWinner, reason: copy.refused } : { plugin: copyAddress, isWinner, ...standingOf(plugins, comparison, copied, NO_STANDING), ...copy };
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
