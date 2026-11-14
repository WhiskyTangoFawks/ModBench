import { describe, it, expect } from 'vitest';
import { hoverOf } from '../formKeyHover';
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

describe('a record\'s hover (symbols.md, The symbols)', () => {
  const reporter = recordingReporter();

  it('shows EditorID [FormKey], the record type and the winning plugin', async () => {
    expect(await hoverOf({ client: askingFor(comparison()), reporter }, FORM_KEY)).toEqual([`\`Gun [${FORM_KEY}]\``, 'Weapon', 'Winner: Mod.esp']);
  });

  it('names the winner among several copies, and takes its EditorID', async () => {
    const answer = comparison([
      { plugin: 'Mod.esp', isWinner: false, editorId: 'Old' },
      { plugin: 'Patch.esp', isWinner: true, editorId: 'New' },
    ]);
    expect(await hoverOf({ client: askingFor(answer), reporter }, FORM_KEY)).toEqual([`\`New [${FORM_KEY}]\``, 'Weapon', 'Winner: Patch.esp']);
  });

  it('shows the FormKey alone when the winner has no EditorID', async () => {
    const answer = comparison([{ plugin: 'Mod.esp', isWinner: true, editorId: null }]);
    expect(await hoverOf({ client: askingFor(answer), reporter }, FORM_KEY)).toEqual([`\`${FORM_KEY}\``, 'Weapon', 'Winner: Mod.esp']);
  });

  it('shows nothing for a FormKey no active plugin holds', async () => {
    expect(await hoverOf({ client: askingFor(null), reporter }, FORM_KEY)).toBeUndefined();
  });

  it('answers nothing, and writes why to the Output, when mEdit cannot answer', async () => {
    const client = { getComparison: () => Promise.reject(new Error('mEdit is down.')) };

    expect(await hoverOf({ client, reporter }, FORM_KEY)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Hover cannot describe ${FORM_KEY}.`, detail: 'mEdit is down.' }]);
  });
});
