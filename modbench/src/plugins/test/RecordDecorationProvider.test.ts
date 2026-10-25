import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, ThemeColor, fakeUri, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri: { from: uriFrom }, ThemeColor, EventEmitter }));

import * as vscode from 'vscode';
import { RecordDecorationProvider } from '../RecordDecorationProvider';
import type { components } from '../../wire/generated/api';

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
  const beneathReads = listeners<undefined>();
  return {
    workingTreeStateOf: () => state,
    statesBeneathOf: () => beneath,
    isExpanded: () => expanded,
    onDidReadRecords: reads.on,
    onDidReadBeneath: beneathReads.on,
    read: reads.emit,
    readBeneath: () => { beneathReads.emit(undefined); },
  };
}

const NO_LOCKED_ROWS = () => new Set<string>();

const MODIFIED = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
const ADDED = new vscode.ThemeColor('gitDecoration.addedResourceForeground');

describe('RecordDecorationProvider', () => {
  const uri = fakeUri('/a record row');

  it.each<[WorkingTreeState, vscode.FileDecoration | undefined]>([
    ['None', undefined],
    ['Modified', { badge: 'M', color: MODIFIED, tooltip: 'Modified' }],
    ['Added', { badge: 'A', color: ADDED, tooltip: 'Added' }],
  ])('badges a record whose working-tree state is %s as git does', (state, decoration) => {
    const provider = new RecordDecorationProvider(source(state), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toEqual(decoration);
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
  const uri = fakeUri('/a row with children');
  const DOT = { badge: '•', tooltip: 'Contains emphasized items' };

  it.each<[string, WorkingTreeState | undefined, WorkingTreeState[], vscode.FileDecoration | undefined]>([
    ['a dot in the modified colour for modifications', 'None', ['Modified'], { ...DOT, color: MODIFIED }],
    ['a dot in the added colour for additions alone', undefined, ['Added'], { ...DOT, color: ADDED }],
    ['a dot in the modified colour for modifications and additions both', 'None', ['Added', 'Modified'], { ...DOT, color: MODIFIED }],
    ['nothing for nothing', 'None', [], undefined],
  ])('shows, while collapsed, %s beneath it', (_case, state, beneath, decoration) => {
    const provider = new RecordDecorationProvider(source(state, beneath), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toEqual(decoration);
  });

  it('shows its own letter rather than the dot when it has a change of its own', () => {
    const provider = new RecordDecorationProvider(source('Added', ['Modified']), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toEqual({ badge: 'A', color: ADDED, tooltip: 'Added' });
  });

  it('shows no dot while expanded, and its own letter still', () => {
    const own = new RecordDecorationProvider(source('Modified', ['Added'], true), NO_LOCKED_ROWS);
    const plain = new RecordDecorationProvider(source('None', ['Added'], true), NO_LOCKED_ROWS);

    expect(own.provideFileDecoration(uri)?.badge).toBe('M');
    expect(plain.provideFileDecoration(uri)).toBeUndefined();
  });

  it('leaves a locked row its grey, whatever is beneath it', () => {
    const provider = new RecordDecorationProvider(source('None', ['Modified']), () => new Set([uri.toString()]));
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('asks VS Code to ask again about every row when the states beneath are read', () => {
    const badges = source('None');
    const provider = new RecordDecorationProvider(badges, NO_LOCKED_ROWS);
    const handler = vi.fn();
    provider.onDidChangeFileDecorations(handler);

    badges.readBeneath();

    expect(handler).toHaveBeenCalledWith(undefined);
  });
});
