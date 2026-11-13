import { describe, it, expect, vi } from 'vitest';
import { enumCompletionsAt } from '../enumCompletion';
import type { CompareResult } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, fieldOf, type Field } from '../../test/comparison';

const OWNER = '000801:Mod.esp';

const asking = (fields: Field[]) => ({
  getComparison: vi.fn((formKey: string): Promise<CompareResult | null> =>
    Promise.resolve(formKey === OWNER ? comparisonOf(formKey, [{ plugin: 'Mod.esp', isWinner: true, fields }]) : null)),
});

const completingAtBar = (client: Parameters<typeof enumCompletionsAt>[0]['client'], marked: string, reporter = recordingReporter()) =>
  enumCompletionsAt({ client, reporter }, marked.replace('|', ''), marked.indexOf('|'));

const documentOf = (members: string) => `{ "FormKey": "${OWNER}", ${members} }`;

describe('enumCompletionsAt (source.md, Editing plugin source, story 2)', () => {
  const members = [{ value: 'Auto', label: 'Automatic' }, { value: 'Single' }];
  const enumField = fieldOf({ name: 'Mode', type: 'enum', enumMembers: members });
  const flagsField = fieldOf({
    name: 'Flags', type: 'flags',
    enumMembers: [{ value: 'Silent', bitValue: '1' }, { value: 'Loud', bitValue: '2', label: 'Noisy' }],
  });

  it('offers its values as the document spells them, before anything is typed', async () => {
    const client = asking([enumField]);
    const found = await completingAtBar(client, documentOf('"Mode": "|"'));

    expect(found?.items).toEqual([
      { label: 'Auto', detail: 'Automatic', insertText: 'Auto' },
      { label: 'Single', detail: '', insertText: 'Single' },
    ]);
  });

  it('replaces the string between its quotes', async () => {
    const marked = documentOf('"Mode": "Si|ng"');
    const found = await completingAtBar(asking([enumField]), marked);

    expect(marked.replace('|', '').slice(found?.start, found?.end)).toBe('Sing');
  });

  it('offers one flag as an element of the array the document writes', async () => {
    const found = await completingAtBar(asking([flagsField]), documentOf('"Flags": ["Silent", "|"]'));

    expect(found?.items.map((item) => item.insertText)).toEqual(['Silent', 'Loud']);
  });

  it('offers the values of an enum nested in structs', async () => {
    const data = fieldOf({ name: 'Data', type: 'struct', fields: [enumField.metadata] });
    const found = await completingAtBar(asking([data]), documentOf('"Data": { "Mode": "|" }'));

    expect(found?.items.map((item) => item.insertText)).toEqual(['Auto', 'Single']);
  });

  it('offers nothing in a property name', async () => {
    expect(await completingAtBar(asking([enumField]), documentOf('"Mo|": 1'))).toBeUndefined();
  });

  it('offers nothing for a string field that has no members', async () => {
    expect(await completingAtBar(asking([fieldOf({ name: 'Mode', type: 'string' })]), documentOf('"Mode": "|"'))).toBeUndefined();
  });
});

it('writes why to the Output, and offers nothing, when mEdit cannot answer the record\'s comparison', async () => {
  const reporter = recordingReporter();

  const found = await completingAtBar({ getComparison: () => Promise.reject(new Error('mEdit is down.')) }, documentOf('"Mode": "|"'), reporter);

  expect(found).toBeUndefined();
  expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Completion cannot list what ${OWNER} offers here.`, detail: 'mEdit is down.' }]);
});
