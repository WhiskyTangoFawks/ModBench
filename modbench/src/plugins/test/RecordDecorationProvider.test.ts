import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, ThemeColor, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, ThemeColor, EventEmitter }));

import * as vscode from 'vscode';
import { RecordDecorationProvider } from '../RecordDecorationProvider';
import type { components } from '../../wire/generated/api';
import type { PluginAddress } from '../../wire/pluginAddress';
import { recordResourceUri, rowResourceUri } from '../recordResourceUri';

type WorkingTreeState = components['schemas']['WorkingTreeState'];

type Listener<T> = (event: T) => void;

function listeners<T>() {
  const held: Listener<T>[] = [];
  return {
    on: (listener: Listener<T>) => { held.push(listener); return { dispose: () => undefined }; },
    emit: (event: T) => { for (const listener of held) listener(event); },
  };
}

function source(
  state: WorkingTreeState | undefined,
  beneath: readonly WorkingTreeState[] = [],
  expanded = false,
) {
  const reads = listeners<readonly vscode.Uri[]>();
  const beneathReads = listeners<readonly PluginAddress[] | undefined>();
  return {
    workingTreeStateOf: () => state,
    statesBeneathOf: () => Promise.resolve(beneath),
    isExpanded: () => expanded,
    onDidReadRecords: reads.on,
    onDidChangeStatesBeneath: beneathReads.on,
    read: reads.emit,
    changeBeneath: beneathReads.emit,
  };
}

const NO_LOCKED_ROWS = () => new Set<string>();

const MODIFIED = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
const ADDED = new vscode.ThemeColor('gitDecoration.addedResourceForeground');

describe('RecordDecorationProvider', () => {
  const uri = Uri.file('/a record row');

  it.each<[WorkingTreeState, vscode.FileDecoration | undefined]>([
    ['None', undefined],
    ['Modified', { badge: 'M', color: MODIFIED, tooltip: 'Modified' }],
    ['Added', { badge: 'A', color: ADDED, tooltip: 'Added' }],
  ])('badges a record whose working-tree state is %s as git does', async (state, decoration) => {
    const provider = new RecordDecorationProvider(source(state), NO_LOCKED_ROWS);
    expect(await provider.provideFileDecoration(uri)).toEqual(decoration);
  });

  it('fires onDidChangeFileDecorations for exactly the rows its source reads', () => {
    const badges = source('None');
    const provider = new RecordDecorationProvider(badges, NO_LOCKED_ROWS);
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    badges.read([uri]);

    expect(handler).toHaveBeenCalledWith([uri]);
  });
});

describe('RecordDecorationProvider, a row with changes beneath it', () => {
  const uri = Uri.file('/a row with children');
  const DOT = { badge: '•', tooltip: 'Contains emphasized items' };

  it.each<[string, WorkingTreeState | undefined, WorkingTreeState[], vscode.FileDecoration | undefined]>([
    ['a dot in the modified colour for modifications', 'None', ['Modified'], { ...DOT, color: MODIFIED }],
    ['a dot in the added colour for additions alone', undefined, ['Added'], { ...DOT, color: ADDED }],
    ['a dot in the modified colour for modifications and additions both', 'None', ['Added', 'Modified'], { ...DOT, color: MODIFIED }],
    ['nothing for nothing', 'None', [], undefined],
  ])('shows, while collapsed, %s beneath it', async (_case, state, beneath, decoration) => {
    const provider = new RecordDecorationProvider(source(state, beneath), NO_LOCKED_ROWS);
    expect(await provider.provideFileDecoration(uri)).toEqual(decoration);
  });

  it('shows its own letter rather than the dot when it has a change of its own', async () => {
    const provider = new RecordDecorationProvider(source('Added', ['Modified']), NO_LOCKED_ROWS);
    expect(await provider.provideFileDecoration(uri)).toEqual({ badge: 'A', color: ADDED, tooltip: 'Added' });
  });

  it('shows no dot while expanded, and its own letter still', async () => {
    const own = new RecordDecorationProvider(source('Modified', ['Added'], true), NO_LOCKED_ROWS);
    const plain = new RecordDecorationProvider(source('None', ['Added'], true), NO_LOCKED_ROWS);

    expect((await own.provideFileDecoration(uri))?.badge).toBe('M');
    expect(await plain.provideFileDecoration(uri)).toBeUndefined();
  });

  it('leaves a locked row its grey, whatever is beneath it', async () => {
    const provider = new RecordDecorationProvider(source('None', ['Modified']), () => new Set([uri.toString()]));
    expect(await provider.provideFileDecoration(uri)).toBeUndefined();
  });

  const PLUGIN: PluginAddress = { name: 'A.esp', origin: 'ModA' };
  const OTHER: PluginAddress = { name: 'B.esp', origin: 'ModA' };

  it('asks VS Code to ask again about every row when the states beneath of every plugin changed', () => {
    const badges = source('None');
    const provider = new RecordDecorationProvider(badges, NO_LOCKED_ROWS);
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    badges.changeBeneath(undefined);

    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('asks VS Code to ask again only about the rows of the named plugin it was asked a decoration of', async () => {
    const badges = source('None');
    const provider = new RecordDecorationProvider(badges, NO_LOCKED_ROWS);
    const pluginRow = rowResourceUri(PLUGIN);
    const record = recordResourceUri(PLUGIN, '000800:A.esp');
    const otherRow = rowResourceUri(OTHER);
    await Promise.all([pluginRow, record, otherRow].map(async (row) => provider.provideFileDecoration(row)));
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    badges.changeBeneath([PLUGIN]);

    expect(handler.mock.calls).toEqual([[[pluginRow, record]]]);
  });
});
