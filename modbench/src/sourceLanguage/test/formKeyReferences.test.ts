import { describe, it, expect, vi } from 'vitest';
import { uriFrom } from '../../test/vscodeMock';

interface TestUri { scheme: string; path: string; query: string; with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri }

const h = vi.hoisted(() => {
  const uri = (scheme: string, path: string, query = ''): TestUri =>
    ({ scheme, path, query, with: (change) => uri(change.scheme ?? scheme, path, change.query ?? query) });
  return { uri };
});

vi.mock('vscode', () => ({
  Uri: { from: uriFrom, file: (path: string) => h.uri('file', path) },
}));

import type * as vscode from 'vscode';
import { referencesOf } from '../formKeyReferences';
import type { ReferenceResult } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';

const GUN = '000900:A.esp';
const STAND = '000700:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const STAND_FILE = '/mods/ModA/plugin-source/A.esp/Stand.json';
const STAND_RENDERED = 'Stand - 000700_A.esp.json';
const AT_GUN = (text: string) => text.indexOf(GUN) + 1;
const ASKING = `{ "FormKey": "000600:A.esp", "Template": "${GUN}" }`;

const row = (formKey: string, plugin: typeof modA, fieldPath: string): ReferenceResult =>
  ({ formKey, plugin: plugin.name, origin: plugin.origin, fieldPath, recordType: 'STAT', recordTypeName: 'Static' });

const key = (formKey: string, { name, origin }: { name: string; origin: string }) => `${formKey} ${name} ${origin}`;

interface Copy { file?: string; rendered?: string; text?: string }

type ReferencesClient = Parameters<typeof referencesOf<{ getText(): string }>>[0]['client'];

function references(rows: ReferenceResult[], copies: Record<string, Copy>, answering: Partial<ReferencesClient> = {}) {
  const firstOnFile = (path: string) => Object.entries(copies).find(([, copy]) => copy.file === path);
  const client: ReferencesClient = {
    getReferencesInActiveOrTrackedPlugins: () => Promise.resolve(rows),
    getRecordOwner: () => Promise.reject(new Error('A referrer\'s copy names its plugin.')),
    getRecordFile: (plugin, formKey) => {
      const copy = copies[key(formKey, plugin)];
      return Promise.resolve(copy ? { path: copy.file ?? null } : null);
    },
    getRecordOfFile: (path) => Promise.resolve({ formKey: firstOnFile(path)?.[0].split(' ')[0] ?? '' }),
    getRenderedDocument: (plugin, formKey) => {
      const copy = copies[key(formKey, plugin)];
      return Promise.resolve(copy?.rendered ? { fileName: copy.rendered } : null);
    },
    ...answering,
  };
  const textAt = (uri: vscode.Uri): string => {
    const query = new URLSearchParams(uri.query);
    const found = uri.scheme === 'modbench-rendered'
      ? copies[key(query.get('formKey') ?? '', { name: query.get('name') ?? '', origin: query.get('origin') ?? '' })]
      : firstOnFile(uri.path)?.[1];
    if (found?.text === undefined) throw new Error('The file is gone.');
    return found.text;
  };
  const reporter = recordingReporter();
  const referencesAt = referencesOf({ client, reporter, open: (uri) => new Promise<{ getText(): string }>((resolve) => { const text = textAt(uri); resolve({ getText: () => text }); }) });
  return { reporter, referencesAt };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof references>['referencesAt']>>) =>
  found.map(({ uri, document, start, end }) => ({ uri: `${uri.scheme}:${uri.path}`, text: document.getText().slice(start, end), start }));

describe('Find All References on a FormKey (plugin-source.md, In the text editor, story 2)', () => {
  it('lists one entry for each plugin\'s copy of a referrer, however many of its fields hold the reference', async () => {
    const tracked = `{ "FormKey": "${STAND}", "Model": "${GUN}", "Keywords": ["${GUN}"] }`;
    const rendered = `{\n  "FormKey": "${STAND}",\n  "Model": "${GUN}"\n}`;
    const { referencesAt } = references(
      [row(STAND, modA, 'Model'), row(STAND, modA, 'Keywords[0]'), row(STAND, modB, 'Model')],
      { [key(STAND, modA)]: { file: STAND_FILE, text: tracked }, [key(STAND, modB)]: { rendered: STAND_RENDERED, text: rendered } },
    );

    expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([
      { uri: `file:${STAND_FILE}`, text: `"${GUN}"`, start: tracked.indexOf(GUN) - 1 },
      { uri: `modbench-rendered:/ModB/B.esp/${STAND_RENDERED}`, text: `"${GUN}"`, start: rendered.indexOf(GUN) - 1 },
    ]);
  });

  describe('a referrer that shares its file with its child records', () => {
    const CELL = '000701:A.esp';
    const PLACED = '000702:A.esp';
    const PERSISTENT = '000703:A.esp';
    const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cell.json';
    const cell = `{ "FormKey": "${CELL}", "Placed": [{ "FormKey": "${PLACED}", "Base": "${GUN}" }], "Owner": "${GUN}", "Persistent": [{ "FormKey": "${PERSISTENT}", "Base": "${GUN}" }] }`;
    const onCell = (...rows: ReferenceResult[]) =>
      references(rows, { [key(CELL, modA)]: { file: CELL_FILE, text: cell }, [key(PERSISTENT, modA)]: { file: CELL_FILE, text: cell } });

    it('lists a child record at the reference in its own object, on its own tab of its owner\'s file', async () => {
      const { referencesAt } = onCell(row(PERSISTENT, modA, 'Base'));

      expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([
        { uri: `modbench-child-record:${CELL_FILE}`, text: `"${GUN}"`, start: cell.lastIndexOf(GUN) - 1 },
      ]);
    });

    it('lists the owner at its own reference, past the references its child records hold', async () => {
      const { referencesAt } = onCell(row(CELL, modA, 'Owner'));

      expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([
        { uri: `file:${CELL_FILE}`, text: `"${GUN}"`, start: cell.indexOf(`"Owner": "${GUN}"`) + '"Owner": '.length },
      ]);
    });
  });

  it('lists a copy whose unsaved document lacks the reference mEdit counts at its record\'s own FormKey', async () => {
    const edited = `{ "Model": "", "FormKey": "${STAND}" }`;
    const { referencesAt } = references([row(STAND, modA, 'Model')], { [key(STAND, modA)]: { file: STAND_FILE, text: edited } });

    expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([
      { uri: `file:${STAND_FILE}`, text: `"${STAND}"`, start: edited.indexOf(STAND) - 1 },
    ]);
  });

  it('lists a copy whose unsaved document lacks its record at the document\'s start', async () => {
    const { referencesAt } = references([row(STAND, modA, 'Model')], { [key(STAND, modA)]: { file: STAND_FILE, text: '{}' } });

    expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([{ uri: `file:${STAND_FILE}`, text: '', start: 0 }]);
  });

  it('lists a record that references itself at the field that holds the reference, never at its own FormKey member', async () => {
    const own = `{ "FormKey": "${GUN}", "Template": "${GUN}" }`;
    const { referencesAt } = references([row(GUN, modA, 'Template')], { [key(GUN, modA)]: { file: STAND_FILE, text: own } });

    expect(listed(await referencesAt(own, AT_GUN(own)))).toEqual([
      { uri: `file:${STAND_FILE}`, text: `"${GUN}"`, start: own.lastIndexOf(GUN) - 1 },
    ]);
  });

  it('passes over a property name that spells the FormKey', async () => {
    const keyed = `{ "FormKey": "${STAND}", "${GUN}": 1, "Model": "${GUN}" }`;
    const { referencesAt } = references([row(STAND, modA, 'Model')], { [key(STAND, modA)]: { file: STAND_FILE, text: keyed } });

    expect(listed(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([
      { uri: `file:${STAND_FILE}`, text: `"${GUN}"`, start: keyed.lastIndexOf(GUN) - 1 },
    ]);
  });

  describe('when a copy cannot be listed', () => {
    const LEFT_OUT = `Find All References on ${GUN} left out a copy it could not open.`;
    const tracked = { [key(STAND, modA)]: { file: STAND_FILE, text: `{ "FormKey": "${STAND}", "Model": "${GUN}" }` } };
    const uris = (found: Parameters<typeof listed>[0]) => listed(found).map(({ uri }) => uri);

    it('writes nothing when every copy is listed', async () => {
      const { reporter, referencesAt } = references([row(STAND, modA, 'Model')], tracked);

      await referencesAt(ASKING, AT_GUN(ASKING));

      expect(reporter.shownFailures).toEqual([]);
    });

    it('lists the copies it can, and writes the copy left out, when a plugin holds no copy mEdit counted', async () => {
      const { reporter, referencesAt } = references([row(STAND, modA, 'Model'), row(STAND, modB, 'Model')], tracked);

      expect(uris(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([`file:${STAND_FILE}`]);
      expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: LEFT_OUT, detail: `B.esp (ModB) holds no ${STAND}.` }]);
    });

    it('lists the copies it can, and writes the copy left out and why, when a copy\'s document fails to open', async () => {
      const { reporter, referencesAt } = references(
        [row(STAND, modA, 'Model'), row(STAND, modB, 'Model')], { ...tracked, [key(STAND, modB)]: { rendered: STAND_RENDERED } },
      );

      expect(uris(await referencesAt(ASKING, AT_GUN(ASKING)))).toEqual([`file:${STAND_FILE}`]);
      expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: LEFT_OUT, detail: `${STAND} in B.esp (ModB): The file is gone.` }]);
    });

    it('lists nothing, and writes to the Output why, when mEdit cannot answer what references it', async () => {
      const { reporter, referencesAt } = references([], {}, { getReferencesInActiveOrTrackedPlugins: () => Promise.reject(new Error('mEdit is gone.')) });

      expect(await referencesAt(ASKING, AT_GUN(ASKING))).toEqual([]);
      expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Find All References cannot list what references ${GUN}.`, detail: 'mEdit is gone.' }]);
    });

    it('writes a line for each copy left out, each time it is asked', async () => {
      const { reporter, referencesAt } = references([row(STAND, modB, 'Model'), row(GUN, modB, 'Template')], {});
      const line = (formKey: string) => ({ severity: 'warning', message: LEFT_OUT, detail: `B.esp (ModB) holds no ${formKey}.` });

      await referencesAt(ASKING, AT_GUN(ASKING));
      await referencesAt(ASKING, AT_GUN(ASKING));

      expect(reporter.shownFailures).toEqual([line(STAND), line(GUN), line(STAND), line(GUN)]);
    });
  });

  it('asks nothing for a string that is not a FormKey', async () => {
    const getReferencesInActiveOrTrackedPlugins = vi.fn(() => Promise.resolve([]));
    const { referencesAt } = references([], {}, { getReferencesInActiveOrTrackedPlugins });
    const text = '{ "Name": "Rusty Gun" }';

    expect(await referencesAt(text, text.indexOf('Rusty'))).toEqual([]);
    expect(getReferencesInActiveOrTrackedPlugins).not.toHaveBeenCalled();
  });
});
