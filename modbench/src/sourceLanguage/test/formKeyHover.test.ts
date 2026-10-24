import { describe, it, expect } from 'vitest';
import { hoverAt } from '../formKeyHover';
import type { CompareResult } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, type Copy } from '../../test/comparison';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const FORM_KEY = '000801:Mod.esp';

const comparison = (copies: Copy[] = [{ plugin: 'Mod.esp', isWinner: true, editorId: 'Gun' }]): CompareResult =>
  comparisonOf(FORM_KEY, copies);

const askingFor = (answer: CompareResult | null) => {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getComparison', answer);
  return client;
};

describe('hoverAt (plugin-source.md, In the text editor, story 3)', () => {
  const reporter = recordingReporter();

  it('shows EditorID [FormKey], the record type and the winning plugin', async () => {
    const text = `{ "Armor": "${FORM_KEY}" }`;
    const hover = await hoverAt({ client: askingFor(comparison()), reporter }, text, text.indexOf('000801') + 2);
    expect(hover?.markdown).toBe(`\`Gun [${FORM_KEY}]\`\n\nWeapon\n\nWinner: Mod.esp`);
  });

  it('spans the FormKey string, quotes included', async () => {
    const text = `{ "Armor": "${FORM_KEY}" }`;
    const hover = await hoverAt({ client: askingFor(comparison()), reporter }, text, text.indexOf('000801'));
    expect(text.slice(hover?.start, hover?.end)).toBe(`"${FORM_KEY}"`);
  });

  it('names the winner among several copies, and takes its EditorID', async () => {
    const answer = comparison([
      { plugin: 'Mod.esp', isWinner: false, editorId: 'Old' },
      { plugin: 'Patch.esp', isWinner: true, editorId: 'New' },
    ]);
    const text = `"${FORM_KEY}"`;
    const hover = await hoverAt({ client: askingFor(answer), reporter }, text, 3);
    expect(hover?.markdown).toBe(`\`New [${FORM_KEY}]\`\n\nWeapon\n\nWinner: Patch.esp`);
  });

  it('shows the FormKey alone when the winner has no EditorID', async () => {
    const answer = comparison([{ plugin: 'Mod.esp', isWinner: true, editorId: null }]);
    const hover = await hoverAt({ client: askingFor(answer), reporter }, `"${FORM_KEY}"`, 3);
    expect(hover?.markdown).toBe(`\`${FORM_KEY}\`\n\nWeapon\n\nWinner: Mod.esp`);
  });

  it('answers the record\'s own root FormKey member too', async () => {
    const text = `{ "FormKey": "${FORM_KEY}" }`;
    const hover = await hoverAt({ client: askingFor(comparison()), reporter }, text, text.indexOf('000801'));
    expect(hover?.markdown).toBe(`\`Gun [${FORM_KEY}]\`\n\nWeapon\n\nWinner: Mod.esp`);
  });

  it('shows nothing for a FormKey no active plugin holds', async () => {
    expect(await hoverAt({ client: askingFor(null), reporter }, `"${FORM_KEY}"`, 3)).toBeUndefined();
  });

  it.each([
    ['a string that is not a FormKey', '{ "Name": "Rusty Gun" }', 'Rusty'],
    ['a FormKey spelled as a property name', `{ "${FORM_KEY}": 1 }`, '000801'],
    ['a place outside a string', `{ "A": "${FORM_KEY}" }`, '{'],
  ])('shows nothing for %s', async (_case, text, at) => {
    expect(await hoverAt({ client: askingFor(comparison()), reporter }, text, text.indexOf(at))).toBeUndefined();
  });

  it('answers nothing, and writes why to the Output, when mEdit cannot answer', async () => {
    const client = { getComparison: () => Promise.reject(new Error('mEdit is down.')) };

    expect(await hoverAt({ client, reporter }, `"${FORM_KEY}"`, 3)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Hover cannot describe ${FORM_KEY}.`, detail: 'mEdit is down.' }]);
  });
});
