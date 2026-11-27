import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { document, host, Location, Range, TreeItem, Uri } from './vscodeHost';
import { symbolsOver } from './symbolsOver';
import { mEditNames, spelledName } from './mEditNames';
import type { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import { comparisonOf } from '../../test/comparison';
import { present } from '../../ports/present';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

const GUN = '000801:A.esp';
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Gun.json';
const GUN_TEXT = `{\n\n\n   "${GUN}" }`;
const ANCHOR = new Location(Uri.file(GUN_FILE), new Range(3, 3, 3, 5 + GUN.length));
const IN_ACTIVE_OR_COMPILED = 'getReferencesInActiveOrCompiledPlugins';

function asking(arrange: (client: InMemoryMEditClient) => void = () => undefined) {
  const made = symbolsOver({
    focusedRecord: () => GUN,
    names: mEditNames((text) => (text === GUN_TEXT ? [spelledName('Record', text, `"${GUN}"`, { record: GUN, fieldPath: 'FormKey', value: GUN })] : [])),
    arrange: (client) => {
      client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, editorId: 'Gun' }]));
      client.setQueryAnswer('getRecordOwners', [{ name: 'A.esp', origin: 'ModA' }]);
      client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
      client.setQueryAnswer(IN_ACTIVE_OR_COMPILED, [{
        formKey: '000900:A.esp', plugin: 'A.esp', origin: 'ModA', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon', editorId: 'Rifle',
      }]);
      host.holds([document(GUN_FILE, GUN_TEXT)]);
      arrange(client);
    },
  });
  const referencesAsked = () => made.client.calls.filter(({ method }) => method.startsWith('getReferences')).map(({ method, args }) => [method, ...args]);
  const ask = async (): Promise<ReferencesViewInput | undefined> => {
    const shown = host.referencesShown.length;
    await host.run('modbench.symbol.referencedBy');
    return host.referencesShown.slice(shown).at(-1);
  };
  return { ...made, referencesAsked, ask };
}

const rowsOf = async (input: ReferencesViewInput | undefined) => {
  const rows = (await present(input, 'the list shown').resolve()).provider.getChildren();
  return Array.isArray(rows) ? rows.filter((row): row is TreeItem => row instanceof TreeItem) : [];
};

describe('Referenced By on a record, answered in VS Code\'s References view (editor-referenced-by.md, Asking)', () => {
  it('shows the record\'s list, titled by its EditorID and anchored at its FormKey in its document', async () => {
    const input = await asking().ask();

    expect([input?.title, input?.location, (await rowsOf(input)).map((row) => row.label)]).toEqual(['Referenced By: Gun', ANCHOR, ['Rifle']]);
  });

  it('reads the list only when the view resolves it, and again on each refresh', async () => {
    const { ask, referencesAsked } = asking();
    const input = present(await ask(), 'the list shown');
    expect(referencesAsked()).toEqual([]);

    await input.resolve();
    const refreshed = input.with(input.location);
    await refreshed.resolve();

    expect(referencesAsked()).toEqual([[IN_ACTIVE_OR_COMPILED, GUN], [IN_ACTIVE_OR_COMPILED, GUN]]);
    expect(refreshed.title).toBe(input.title);
  });

  it('gives each list its own rows, so the same record asked about again shows collapsed, and the view\'s refresh keeps what was expanded', async () => {
    const { ask } = asking();
    const first = present(await ask(), 'the first list');
    const again = present(await ask(), 'the list asked for again');
    const refreshed = first.with(first.location);
    const idsOf = async (input: ReferencesViewInput): Promise<unknown[]> => (await rowsOf(input)).map((row): unknown => Reflect.get(row, 'id'));

    expect(await idsOf(again)).not.toEqual(await idsOf(first));
    expect(await idsOf(refreshed)).toEqual(await idsOf(first));
  });

  it('is refused, saying why, when the record has no place in a document', async () => {
    const { ask, reporter } = asking((client) => { client.setQueryAnswer('getCopyDocument', null); });

    expect(await ask()).toBeUndefined();
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Could not list what references ${GUN}.`, detail: 'A.esp (ModA) holds no 000801:A.esp.' }]);
  });
});
