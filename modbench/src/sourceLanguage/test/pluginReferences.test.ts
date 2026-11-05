import { describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import type * as vscode from 'vscode';
import { listMessage, pluginReferencesOf } from '../pluginReferences';
import { heldTexts, type HeldTexts, type PlaceInFile, type PluginSymbol, type SymbolOwner, type SymbolReading } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const BASE_LOSING = { name: 'Base.esm', origin: 'Old Base Mod' };
const CHILD = { name: 'Child.esp', origin: 'Child Mod' };
const plugins = [{ ...BASE, winning: true }, { ...BASE_LOSING, winning: false }, { ...CHILD, winning: true }];

const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const place = (file: string, line: number): PlaceInFile => ({ file, start: { line, character: 1 }, end: { line, character: 9 } });

function fakeOwner(reading: SymbolReading): SymbolOwner & { asked: [PluginSymbol, HeldTexts][] } {
  const asked: [PluginSymbol, HeldTexts][] = [];
  return {
    asked,
    read: (symbol, held) => { asked.push([symbol, held]); return Promise.resolve(reading); },
    nameAt: () => Promise.resolve(undefined),
  };
}

function references(owners: SymbolOwner[], copies: Record<string, CopyOnDisk> = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(copies);
  const textAt = (uri: vscode.Uri): string => {
    const query = new URLSearchParams(uri.query);
    const found = uri.scheme === 'modbench-rendered'
      ? copies[key(query.get('formKey') ?? '', { name: query.get('name') ?? '', origin: query.get('origin') ?? '' })]?.text
      : textOnFile(uri.path);
    if (found === undefined) throw new Error('The file is gone.');
    return found;
  };
  const reporter = recordingReporter();
  const held = heldTexts([['/source/Child Mod/build.json', '{}']]);
  const referencesTo = pluginReferencesOf({
    owners, plugins: () => plugins, held: () => held, reporter,
    client: { getCopyDocument, getRecordOwner: () => Promise.reject(new Error('A copy names its plugin.')) },
    open: (uri) => Promise.resolve({ getText: () => textAt(uri) }),
  });
  return { reporter, referencesTo, held };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof references>['referencesTo']>>['found']) =>
  found.map((each) => ('file' in each ? each : { uri: `${each.uri.scheme}:${each.uri.path}`, text: each.document.getText().slice(each.start, each.end) }));

describe('Find All References on a plugin (symbols.md, The features, story 2)', () => {
  it('lists each place an owner reports that names the plugin, handing each owner the unsaved text', async () => {
    const owner = fakeOwner({ references: [{ place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } }], leftOut: [] });
    const { referencesTo, held } = references([owner]);

    expect(await referencesTo(BASE)).toEqual({ found: [place(PLUGINS_TXT, 1)], unread: [] });
    expect(owner.asked).toEqual([[BASE, held]]);
  });

  it('leaves out a name that names another copy: a file name alone names the copy mod order resolves it to', async () => {
    const owner = fakeOwner({ references: [
      { place: place(PLUGINS_TXT, 1), names: { name: 'Base.esm' } },
      { place: place('/source/Old Base Mod/build.json', 2), names: { name: 'Base.esm', origin: 'Old Base Mod' } },
    ], leftOut: [] });

    expect((await references([owner]).referencesTo(BASE_LOSING)).found).toEqual([place('/source/Old Base Mod/build.json', 2)]);
  });

  it('lists a copy at each FormKey in its document that names the plugin, and a master at its plugin\'s header (story 10)', async () => {
    const NPC = '000800:Child.esp';
    const rendered = `{ "FormKey": "000000:Child.esp", "Description": "" }`;
    const npc = `{ "FormKey": "${NPC}", "Race": "000801:Base.esm" }`;
    const owner = fakeOwner({ references: [
      { copy: { formKey: '000000:Child.esp', plugin: CHILD }, names: { name: 'Base.esm' } },
      { copy: { formKey: NPC, plugin: CHILD }, names: { name: 'Base.esm' } },
    ], leftOut: [] });
    const { referencesTo } = references([owner], {
      [key('000000:Child.esp', CHILD)]: { rendered: 'Header.json', text: rendered },
      [key(NPC, CHILD)]: { file: '/source/Child Mod/plugin-source/Child.esp/Npc.json', text: npc },
    });

    expect(listed((await referencesTo(BASE)).found)).toEqual([
      { uri: 'modbench-rendered:/Child%20Mod/Child.esp/Header.json', text: '"000000:Child.esp"' },
      { uri: 'file:/source/Child Mod/plugin-source/Child.esp/Npc.json', text: 'Base.esm' },
    ]);
  });

  it('notifies, naming each, of a file an owner could not read and of a copy it could not open (common.md, Reporting)', async () => {
    const owners = [
      fakeOwner({ references: [{ copy: { formKey: '000800:Child.esp', plugin: CHILD }, names: { name: 'Base.esm' } }], leftOut: ['/userlist.yaml: it does not read'] }),
      { read: () => Promise.reject(new Error('The disk is gone.')), nameAt: () => Promise.resolve(undefined) },
    ];
    const { referencesTo, reporter } = references(owners);
    const unread = ['/userlist.yaml: it does not read', 'The disk is gone.', 'Child.esp (Child Mod) holds no 000800:Child.esp.'];

    expect(await referencesTo(BASE)).toEqual({ found: [], unread });
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Find All References on Base.esm (Base Mod) could not read every file that may name it.', detail: unread.join('\n'),
    }]);
  });
});

describe('the line above a plugin\'s list (common.md, States, story 3)', () => {
  it('says the list is empty only where every file was read', () => {
    expect([listMessage(0, 0), listMessage(0, 1), listMessage(2, 1)]).toEqual([
      'No references found.', 'No references found in the files that could be read.', undefined,
    ]);
  });
});
