import { z } from 'zod';
import type { CopyDocument, MEditClient } from '../client/MEditClient';
import { pluginAddressOf, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { copyColumnKey } from '../wire/columnKey';
import { fileStanding } from '../drivingLib/fileStanding';
import { copyStatusMessage, NO_STANDING, pluginOf, type Standing } from '../drivingLib/columnStatus';
import { toolNamed } from './toolNames';
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
import { fitting } from './tooLarge';

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

const statusForAgent = (...given: Parameters<typeof copyStatusMessage>) => {
  const status = copyStatusMessage(...given);
  return status === null ? null : { ...status, reason: toolNamed(status.reason) };
};

type Plugins = Extract<Awaited<ReturnType<RecordReads['getPlugins']>>, readonly unknown[]>;

const standingOf = (plugins: Plugins, comparison: CompareResult, copy: CompareOverride, standing: Standing) => {
  const status = statusForAgent(copy, pluginOf(plugins, copy), standing);
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
    ? statusForAgent({ plugin: address.name, origin: address.origin, isPartialForm: false, isInOverwrite: false }, undefined, standing)
    : null;
  return status === null ? {} : { status };
};

const sqlText = (text: string): string => `'${text.replaceAll("'", "''")}'`;

export const READ_RECORD = {
  name: 'read_record',
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
      return fitting({ ...(await standingIn(mEdit, value, formKey, address)), ...copy }, (whole) => ({
        chars: JSON.stringify(whole).length,
        narrow: `select_rows reads parts of the copy's body, such as one field or one child record, from the records view WHERE form_key = ${sqlText(formKey)} AND plugin = ${sqlText(address.name)} AND origin = ${sqlText(address.origin)}.`,
      }));
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
    const fitted = fitting(entries, (copies) => ({
      copies: copies.map((entry) => ({ plugin: entry.plugin, isWinner: entry.isWinner, chars: JSON.stringify(entry).length })),
      narrow: 'plugin narrows the read to one copy.',
    }));
    const reasons = fitted.flatMap((entry) => ('reason' in entry ? [entry.reason] : []));
    if (reasons.length > 0) throw new Refusal(reasons.join(' '), fitted);
    return fitted;
  },
};

export const LIST_REFERENCES = {
  name: 'list_references',
  input: { name: z.string() },
  of: async (mEdit: Pick<MEditClient, 'resolveNames' | 'getReferences'>, { name }: { name: string }) => {
    const [formKey = ''] = await formKeysNamed(mEdit, [name]);
    const referrers = await mEdit.getReferences(formKey);
    if (isReadFailed(referrers)) throw new Refusal(failureReason(referrers));
    return fitting(referrers, (all) => ({
      references: all.length,
      narrow: `select_rows reads them as the rows of the form_references view whose target_form_key is ${formKey}, which its WHERE narrows further.`,
    }));
  },
};
