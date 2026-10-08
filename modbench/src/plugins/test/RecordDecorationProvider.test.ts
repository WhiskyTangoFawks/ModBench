import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
  ThemeColor: class { constructor(public id: string) {} },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach((h) => h(e)); }
  },
}));

import * as vscode from 'vscode';
import { RecordDecorationProvider } from '../RecordDecorationProvider';
import { fakeUri } from '../../test/vscodeMock';
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
  state: WorkingTreeState | undefined | ((uri: vscode.Uri) => WorkingTreeState | undefined),
  beneath: readonly WorkingTreeState[] = [],
  expanded = false,
) {
  const reads = listeners<readonly vscode.Uri[]>();
  const beneathReads = listeners<undefined>();
  return {
    workingTreeStateOf: typeof state === 'function' ? state : () => state,
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

  it('returns undefined when the lookup reports no working-tree change', () => {
    const provider = new RecordDecorationProvider(source('None'), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('badges a Modified record with M and the git modified colour', () => {
    const provider = new RecordDecorationProvider(source('Modified'), NO_LOCKED_ROWS);
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({ badge: 'M', color: MODIFIED, tooltip: 'Modified' });
  });

  it('badges an Added record with A and the git added colour', () => {
    const provider = new RecordDecorationProvider(source('Added'), NO_LOCKED_ROWS);
    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toEqual({ badge: 'A', color: ADDED, tooltip: 'Added' });
  });

  it('asks its source about the URI VS Code names', () => {
    const lookup = vi.fn().mockReturnValue('None');
    const provider = new RecordDecorationProvider(source(lookup), NO_LOCKED_ROWS);
    provider.provideFileDecoration(uri);
    expect(lookup).toHaveBeenCalledWith(uri);
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

  it('shows a dot in the modified colour while collapsed', () => {
    const provider = new RecordDecorationProvider(source('None', ['Modified']), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toEqual({ ...DOT, color: MODIFIED });
  });

  it('shows a dot in the added colour when only additions are beneath it', () => {
    const provider = new RecordDecorationProvider(source(undefined, ['Added']), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toEqual({ ...DOT, color: ADDED });
  });

  it('takes the modified colour when modifications and additions are both beneath it', () => {
    const provider = new RecordDecorationProvider(source('None', ['Added', 'Modified']), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)?.color).toEqual(MODIFIED);
  });

  it('shows nothing when nothing is beneath it', () => {
    const provider = new RecordDecorationProvider(source('None', []), NO_LOCKED_ROWS);
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
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
