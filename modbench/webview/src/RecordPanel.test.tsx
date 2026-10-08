import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, hasSection } from '../../src/wire/messages';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { DIMMED_OPACITY } from './gridStyles';
import type { FieldMetadata } from './types';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastPostedEnvelope, lastToldCell, member, panelClient,
  parseJsonRecord, required,
  type PanelOpts,
} from './test/fixtures';
import type { CompareResult, PluginLoadFailure } from './types';

const strMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'string' });

const compareResult: CompareResult = compareResultFixture({
  conflictAll: 'Conflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      isWinner: false,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Original Name' },
      ],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      isWinner: true,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Override Name' },
      ],
      conflictThis: 'ConflictWins',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp',
      cellStates: { 'MyMod.esp': 'ConflictWins' },
      conflictAll: 'Conflict',
    }),
  ],
});

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

const immutableWinnerCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'OnlyOne',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'OnlyOne',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name' },
      winnerColumn: 'Fallout4.esm', cellStates: {},
    }),
  ],
});

const intMeta: FieldMetadata = fieldMeta({ name: 'Level', type: 'int' });
const fkMeta: FieldMetadata = fieldMeta({
  name: 'Race', type: 'formKey', validFormKeyTypes: ['race']});

const RESOLVED_SO_THE_FORMKEY_AFFORDANCE_IS_EXERCISED = { state: 'ResolvedValidType', recordType: 'race', editorId: 'HumanRace' } as const;

const fkCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'OnlyOne',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '00013918:Fallout4.esm' }],
      conflictThis: 'OnlyOne',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Race',
      values: { 'Fallout4.esm': '00013918:Fallout4.esm' },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
      resolutions: { 'Fallout4.esm': RESOLVED_SO_THE_FORMKEY_AFFORDANCE_IS_EXERCISED },
    }),
  ],
});

const overrideCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'Conflict',
  overrides: [
    compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'Master' }),
    compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }], conflictThis: 'Override' }),
  ],
  diffs: [diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
    winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override' })],
});

const twoSiblingFieldsResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }, { metadata: intMeta, value: 5 }], conflictThis: 'Master' }),
    compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }, { metadata: intMeta, value: 5 }], conflictThis: 'Override' }),
  ],
  diffs: [
    diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' },
      conflictAll: 'Override' }),
    diffNode({ fieldName: 'Level', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 },
      winnerColumn: 'MyMod.esp', cellStates: {},
      conflictAll: 'NoConflict' }),
  ],
});

const partialFormTrackedPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

const partialFormCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'IdenticalToMaster',
      isPartialForm: true,
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': null },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
    }),
  ],
});

const flagsFieldMeta: FieldMetadata = fieldMeta({
  name: 'Flags', type: 'flags',
  enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' }]});

const flagsCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'NoConflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Original Name' },
        { metadata: flagsFieldMeta, value: ['A', 'B'] },
      ],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Override Name' },
        { metadata: flagsFieldMeta, value: ['A', 'B'] },
      ],
      conflictThis: 'IdenticalToMaster',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
    }),
    diffNode({
      fieldName: 'Flags',
      values: { 'Fallout4.esm': ['A', 'B'], 'MyMod.esp': ['A', 'B'] },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
    }),
  ],
});

const trackedMyModPluginsForTheRealEditableColumnsGate = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

const structFieldMeta: FieldMetadata = fieldMeta({
  name: 'Bounds',
  type: 'struct',
  fields: [
    fieldMeta({ name: 'X', type: 'int' }),
    fieldMeta({ name: 'Y', type: 'int' }),
  ]});

const structCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      isWinner: false,
      editorId: 'TestNPC',
      fields: [{ metadata: structFieldMeta, value: { X: 10, Y: 20 } }],
      conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: structFieldMeta, value: { X: 15, Y: 20 } }],
      conflictThis: 'Override',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Bounds',
      values: { 'Fallout4.esm': { X: 10, Y: 20 }, 'MyMod.esp': { X: 15, Y: 20 } },
      winnerColumn: 'MyMod.esp',
      cellStates: { 'MyMod.esp': 'Override' },
      children: [
        diffNode({
          fieldName: 'X',
          values: { 'Fallout4.esm': 10, 'MyMod.esp': 15 },
          winnerColumn: 'MyMod.esp',
          cellStates: { 'MyMod.esp': 'Override' },
        }),
        diffNode({
          fieldName: 'Y',
          values: { 'Fallout4.esm': 20, 'MyMod.esp': 20 },
          winnerColumn: 'MyMod.esp',
          cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        }),
      ],
    }),
  ],
});

function renderPanel(compare: CompareResult, opts: PanelOpts = {}) {
  const client = panelClient(() => compare, { plugins: pluginsResponse, ...opts });
  return { client, ...render(<RecordPanel client={client} />) };
}

describe('RecordPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the record type as xEdit names it, then EditorID [FormKey], in one line with no controls', async () => {
    renderPanel({ ...compareResult, recordTypeName: 'Weapon' });
    const header = await screen.findByText('Weapon TestNPC [000001:Fallout4.esm]');
    expect(header.querySelector('input, button, select')).toBeNull();
  });

  it('reads the FormKey alone after the record type when there is no EditorID', async () => {
    renderPanel({
      ...compareResult, recordTypeName: 'Weapon',
      overrides: compareResult.overrides.map(o => ({ ...o, editorId: null })),
    });
    expect(await screen.findByText('Weapon 000001:Fallout4.esm')).toBeInTheDocument();
  });

  it('shows field names from the diff table', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
  });

  it('shows each override\'s own field value in its own column, master leftmost and winner rightmost as in xEdit', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());
    const master = screen.getByText('Original Name');
    const winner = screen.getByText('Override Name');
    expect(master.compareDocumentPosition(winner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a cell in an immutable column opens nothing when clicked, as nothing ever reaches a write from here', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

});

describe('RecordPanel — the file\'s column', () => {
  const twoTracked: CompareResult = compareResultFixture({
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA', editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'File Name' }] }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Other.esp', origin: 'ModB', isWinner: true, editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Other Name' }] }),
    ],
    diffs: [diffNode({ fieldName: 'Name', values: { 'MyMod.esp|ModA': 'File Name', 'Other.esp|ModB': 'Other Name' }, winnerColumn: 'Other.esp|ModB' })],
  });
  const bothTracked = [{ name: 'MyMod.esp', origin: 'ModA', isTracked: true }, { name: 'Other.esp', origin: 'ModB', isTracked: true }];
  const headerOf = (plugin: string) => required(screen.getByText(plugin).closest('th'), `${plugin}'s header`);

  beforeEach(() => { vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'); });
  afterEach(() => vi.unstubAllGlobals());

  it('is the one column a cell edits in: a cell of another tracked column opens no editor and tells no edit', async () => {
    renderPanel(twoTracked, { plugins: bothTracked, fileColumn: 'MyMod.esp|ModA' });
    await waitFor(() => expect(screen.getByText('Other Name')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Other Name'));
    fireEvent.doubleClick(screen.getByText('Other Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(lastToldCell(vscode.postMessage)).toMatchObject({ plugin: 'Other.esp' });
    expect(hasSection(lastToldCell(vscode.postMessage), 'editableCell')).toBe(false);

    fireEvent.doubleClick(screen.getByText('File Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('is marked in its header, to the eye and to a screen reader, and no other column is', async () => {
    renderPanel(twoTracked, { plugins: bothTracked, fileColumn: 'MyMod.esp|ModA' });
    await waitFor(() => expect(screen.getByText('Other Name')).toBeInTheDocument());

    expect(headerOf('MyMod.esp')).toHaveAttribute('aria-current', 'true');
    expect(headerOf('MyMod.esp').querySelector('.codicon.codicon-edit')).not.toBeNull();
    expect(headerOf('Other.esp')).not.toHaveAttribute('aria-current');
    expect(headerOf('Other.esp').querySelector('.codicon')).toBeNull();
  });

  it('opens another column\'s copy on Enter or Space on its focused header, and nothing on another key or on its own header', async () => {
    renderPanel(twoTracked, { plugins: bothTracked, fileColumn: 'MyMod.esp|ModA' });
    await waitFor(() => expect(screen.getByText('Other Name')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    expect(headerOf('Other.esp')).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(headerOf('MyMod.esp'), { key: 'Enter' });
    fireEvent.keyDown(headerOf('Other.esp'), { key: 'ArrowDown' });
    fireEvent.keyDown(within(headerOf('Other.esp')).getByRole('button'), { key: 'Enter' });
    fireEvent.keyDown(headerOf('Other.esp'), { key: 'Enter' });
    fireEvent.keyDown(headerOf('Other.esp'), { key: ' ' });

    expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === WEBVIEW_TO_EXTENSION.OPEN_COLUMNS)).toHaveLength(2);
  });

  it('opens another column\'s copy on a click on its header, and nothing on a click on its own or on a collapse control', async () => {
    renderPanel(twoTracked, { plugins: bothTracked, fileColumn: 'MyMod.esp|ModA' });
    await waitFor(() => expect(screen.getByText('Other Name')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(headerOf('MyMod.esp'));
    fireEvent.click(within(headerOf('Other.esp')).getByRole('button'));
    fireEvent.click(headerOf('Other.esp'));

    expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === WEBVIEW_TO_EXTENSION.OPEN_COLUMNS)).toEqual([[{
      type: WEBVIEW_TO_EXTENSION.OPEN_COLUMNS, records: [{ formKey: '000001:Fallout4.esm', plugin: { name: 'Other.esp', origin: 'ModB' } }],
    }]]);
  });
});

describe('RecordPanel — column header native right-click menu', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the header cell carries the recordHeader context, naming this column\'s own record identity', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = compareResultFixture({
      conflictAll: 'OnlyOne',
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      })],
      diffs: [diffNode({
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    });
    const { container } = renderPanel(compare);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const headerContext = required(
      container.querySelector('th[data-vscode-context]'), 'the header cell carrying the context',
    ).getAttribute('data-vscode-context') ?? '';
    expect(JSON.parse(headerContext)).toEqual({
      webviewSection: 'recordHeader',
      argument: { kind: 'record', plugin: { name: 'MyMod.esp', origin: 'ModA' }, formKey: '000001:Fallout4.esm' },
      compilable: false, editable: false, inMod: 'none', preventDefaultContextMenuItems: true,
    });
  });

  it.each([
    ['a tracked, editable', { isTracked: true, isImmutable: false }, true, true],
    ['an untracked', { isTracked: false, isImmutable: false }, false, false],
    ['a tracked, plugin-source-unreadable', { isTracked: true, pluginSourceUnreadable: true }, true, false],
    ['a read-only', { isTracked: true, isImmutable: true }, false, false],
    ['an untracked read-only', { isTracked: false, isImmutable: true }, false, false],
  ])('the header of %s plugin says whether compile and delete apply to it, compile on a tracked column, delete only where the plugin source reads too', async (_what, facts, compilable, editable) => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = compareResultFixture({
      conflictAll: 'OnlyOne',
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      })],
      diffs: [diffNode({
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    });
    const { container } = renderPanel(compare, { plugins: [{ name: 'MyMod.esp', origin: 'ModA', ...facts }] });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    await waitFor(() => {
      const headerContext = container.querySelector('th[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '{}';
      expect(parseJsonRecord(headerContext)).toMatchObject({ compilable, editable });
    });
  });

  it.each([
    ['an active plugin in a tracked mod', { isTracked: true }, { ModA: 'tracked' }, 'tracked'],
    ['a disabled plugin in a tracked mod', { isTracked: true, isImmutable: true }, { ModA: 'tracked' }, 'tracked'],
    ['an active plugin in an untracked mod', { isTracked: false }, { ModA: 'untracked' }, 'untracked'],
    ['a disabled plugin in an untracked mod', { isTracked: false, isImmutable: true }, { ModA: 'untracked' }, 'untracked'],
    ['a plugin the game provides', { isTracked: false, isImmutable: true }, {}, 'none'],
    ['a plugin in Overwrite', { isTracked: false }, {}, 'none'],
  ] as const)('the header of %s names the repository state of its origin\'s mod, which track and decompile are offered on', async (_what, facts, modsByOrigin, inMod) => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = compareResultFixture({
      conflictAll: 'OnlyOne',
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      })],
      diffs: [diffNode({
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    });
    const { container } = renderPanel(compare, { plugins: [{ name: 'MyMod.esp', origin: 'ModA', ...facts }], modsByOrigin });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    await waitFor(() => {
      const headerContext = container.querySelector('th[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '{}';
      expect(parseJsonRecord(headerContext)).toMatchObject({ inMod });
    });
  });

  it('changes the repository state its header names when the host says the mod changed, without reading the record again', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = compareResultFixture({
      conflictAll: 'OnlyOne',
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      })],
      diffs: [diffNode({
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    });
    const { container, client } = renderPanel(compare, { plugins: [{ name: 'MyMod.esp', origin: 'ModA' }], modsByOrigin: { ModA: 'untracked' } });
    const inMod = () => parseJsonRecord(container.querySelector('th[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '{}').inMod;
    await waitFor(() => expect(inMod()).toBe('untracked'));

    sendMessage({ type: EXTENSION_TO_WEBVIEW.MODS_CHANGED, modsByOrigin: { ModA: 'tracked' } });

    await waitFor(() => expect(inMod()).toBe('tracked'));
    expect(client.load).toHaveBeenCalledTimes(1);
  });

  it('offers no compile on a column whose tracked state is unknown, as when /plugins fails a column is neither tracked nor untracked', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = compareResultFixture({
      conflictAll: 'OnlyOne',
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      })],
      diffs: [diffNode({
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      })],
    });
    const load = vi.fn().mockResolvedValue({
      ok: true, result: compare, immutableSet: null, trackedSet: null, sourceUnreadableSet: null, modsByOrigin: {}, conflictsComputed: true, loadFailures: [],
    });
    const { container } = renderPanel(compare, { load });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const headerContext = container.querySelector('th[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '{}';
    expect(parseJsonRecord(headerContext)).toMatchObject({ compilable: false, editable: false, inMod: 'none' });
  });
});

describe('RecordPanel — a vanilla master column', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is not dimmed', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Fallout4.esm')).toBeInTheDocument());

    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    const th = screen.getByText('Fallout4.esm').closest('th');
    expect(th).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

describe('RecordPanel — a Partial Form column', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads (Partial Form) in its dimmed header, with no control on it', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('(Partial Form)')).toBeInTheDocument());

    const th = required(screen.getByText('MyMod.esp').closest('th'), 'the column\u2019s header');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    expect(th.querySelector('input')).toBeNull();
  });

  it('is dimmed under an earlier status too', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('(untracked)')).toBeInTheDocument());

    expect(screen.getByText('MyMod.esp').closest('th')).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('renders every cell of that column dimmed too, as one dimmed set reaches the header and every cell under it: a header-only rule would leave the cells at full weight once the non-sticky header scrolls away', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());

    const nameRow = screen.getByText('Name').closest('tr');
    if (!nameRow) throw new Error('expected a tr ancestor of the Name row');
    const cells = nameRow.querySelectorAll('td');
    expect(cells[2]).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    expect(cells[1]).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('drops a diff node naming a member no override\'s schema declares, as the panel resolves every row\'s schema leaf itself and such a node has no shape to render against', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel({
      ...compareResult,
      diffs: [...compareResult.diffs, {
        fieldName: 'Undeclared', values: { 'MyMod.esp': 'x' }, winnerColumn: 'MyMod.esp',
cellStates: {}, conflictAll: 'NoConflict',
      }],
    });
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
    expect(screen.queryByText('Undeclared')).not.toBeInTheDocument();
  });
});

describe('RecordPanel — flags cell editing through real message plumbing', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('control: a scalar cell in the identical tracked, editable column the flags cases use opens an editable input on double click', async () => {
    renderPanel(flagsCompareResult, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Override Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('opens no input on a cell of a tracked column whose plugin source is unreadable', async () => {
    renderPanel(flagsCompareResult, {
      plugins: trackedMyModPluginsForTheRealEditableColumnsGate.map(p => ({ ...p, pluginSourceUnreadable: true })),
    });
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Override Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('a flags row opens expanded with its checkboxes; collapsing shows the summary and expanding restores them', async () => {
    renderPanel(flagsCompareResult, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(4));
    const flagsRow = () => required(screen.getByText('Flags').closest('tr'), "the Flags row");

    fireEvent.click(within(flagsRow()).getByRole('button', { name: '▼' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('A, B')).toHaveLength(2);

    fireEvent.click(within(flagsRow()).getByRole('button', { name: '▶' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
  });

  it('reads a read-only column\u2019s flags as the editable column\u2019s do, as nothing marks its cells ahead of time, and writes nothing on a click', async () => {
    renderPanel(flagsCompareResult, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(4));
    const [, masterCell, modCell] = Array.from(required(screen.getByText('Flags').closest('tr'), 'the Flags row').querySelectorAll('td'));
    const boxesOf = (cell: Element | undefined) =>
      Array.from(required(cell, 'a value cell').querySelectorAll('input')).map(box => ({ checked: box.checked, disabled: box.disabled }));
    expect(boxesOf(masterCell)).toEqual(boxesOf(modCell));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(required(masterCell?.querySelector('input'), 'the master’s first flag'));

    expect(lastPostedEnvelope(vi.mocked(vscode.postMessage))).toBeUndefined();
    expect(boxesOf(masterCell)).toEqual(boxesOf(modCell));
  });

  it('toggling a flag posts set of the member with the names now set', async () => {
    renderPanel(flagsCompareResult, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0));
    vi.mocked(vscode.postMessage).mockClear();

    const modCell = required(screen.getByText('Flags').closest('tr')?.lastElementChild, 'the tracked column\u2019s cell');
    fireEvent.click(required(modCell.querySelector('input'), 'its first flag'));

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Flags' }], value: ['B'] },
    }));
  });
});

describe('RecordPanel — conflict color coding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies green row background to a field whose own conflictAll is Override, each field\'s own diffs[].conflictAll driving its own row, never the record-wide CompareResult.conflictAll', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr');
    if (!row) throw new Error('expected a tr ancestor of the Name row');
    expect(row.style.backgroundColor).toBe('var(--vscode-modbench-conflictRowOverride)');
  });

  it('applies orange row background to a field whose own conflictAll is Conflict', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr');
    if (!row) throw new Error('expected a tr ancestor of the Name row');
    expect(row.style.backgroundColor).toBe('var(--vscode-modbench-conflictRowConflict)');
  });

  it('colors only the field that actually differs — an agreeing sibling row gets no background', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(twoSiblingFieldsResult);
    await waitFor(() => screen.getByText('Name'));
    const nameRow = screen.getByText('Name').closest('tr');
    const levelRow = screen.getByText('Level').closest('tr');
    if (!nameRow) throw new Error('expected a tr ancestor of the Name row');
    if (!levelRow) throw new Error('expected a tr ancestor of the Level row');
    expect(nameRow.style.backgroundColor).toBe('var(--vscode-modbench-conflictRowOverride)');
    expect(levelRow.style.backgroundColor).toBe('');
  });

  it('applies orange cell background when cellStates is ConflictWins', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td');
    if (!cell) throw new Error('expected a td ancestor of the Override Name cell');
    expect(cell.style.backgroundColor).toBe('var(--vscode-modbench-conflictWins)');
  });

  it('applies green cell background when cellStates is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td');
    if (!cell) throw new Error('expected a td ancestor of the Override Name cell');
    expect(cell.style.backgroundColor).toBe('var(--vscode-modbench-conflictOverride)');
  });

  it('column header background reflects CompareOverride.conflictThis', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const header = screen.getByText('MyMod.esp').closest('th');
    if (!header) throw new Error('expected a th ancestor of the MyMod.esp header cell');
    expect(header.style.backgroundColor).toBe('var(--vscode-modbench-conflictWins)');
  });
});

describe('RecordPanel — conflict cell tooltips and colours', () => {
  const columns = ['Fallout4.esm', 'Same.esp', 'Loser.esp', 'Winner.esp', 'Empty.esp'];
  const threeWayResult: CompareResult = compareResultFixture({
    conflictAll: 'Conflict',
    overrides: columns.map((plugin, i) => compareOverride({
      formKey: '000001:Fallout4.esm', plugin, isWinner: i === 3, editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'x' }], loadIndex: `0${i}`,
    })),
    diffs: [diffNode({
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'A', 'Same.esp': 'A', 'Loser.esp': 'B', 'Winner.esp': 'C' },
      winnerColumn: 'Winner.esp',
      cellStates: { 'Same.esp': 'IdenticalToMaster', 'Loser.esp': 'ConflictLoses', 'Winner.esp': 'ConflictWins' },
      conflictAll: 'Conflict',
    })],
  });

  const cellOf = async (text: string): Promise<HTMLElement> => {
    const cell = (await screen.findByText(text)).closest('td');
    if (!cell) throw new Error(`expected a td ancestor of ${text}`);
    return cell;
  };

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('paints a losing cell red, in red text, and names it', async () => {
    renderPanel(threeWayResult);
    const cell = await cellOf('B');
    expect(cell.style.backgroundColor).toBe('var(--vscode-modbench-conflictLoses)');
    expect(cell.style.color).toBe('var(--vscode-modbench-conflictLosesText)');
    expect(cell.title).toBe('Conflict loser');
  });

  it('paints an unchanged copy grey and names it', async () => {
    renderPanel(threeWayResult);
    const cell = (await screen.findAllByText('A'))[1]?.closest('td');
    expect(cell?.style.backgroundColor).toBe('var(--vscode-modbench-conflictIdenticalToMaster)');
    expect(cell?.title).toBe('Identical to Master');
  });

  it('names the winning cell', async () => {
    renderPanel(threeWayResult);
    expect((await cellOf('C')).title).toBe('Conflict winner');
  });

  it('names the first loaded column Master, with no colour', async () => {
    renderPanel(threeWayResult);
    const cell = (await screen.findAllByText('A'))[0]?.closest('td');
    expect(cell?.title).toBe('Master');
    expect(cell?.style.backgroundColor).toBe('');
  });

  it('gives a column with nothing on the row no colour and no tooltip', async () => {
    renderPanel(threeWayResult);
    await cellOf('B');
    const nameRow = screen.getByText('Name').closest('tr');
    const empty = nameRow?.querySelectorAll('td')[columns.length];
    expect(empty?.style.backgroundColor).toBe('');
    expect(empty?.title).toBe('');
  });

  it('paints no colour on the header of a column with no cell state', async () => {
    renderPanel(compareResultFixture({
      overrides: [
        compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'x' }], conflictThis: 'Master' }),
        compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Empty.esp', editorId: 'TestNPC', fields: [], conflictThis: null }),
      ],
      diffs: [diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'A' }, winnerColumn: 'Fallout4.esm' })],
    }));
    await cellOf('A');
    expect(screen.getByText('Empty.esp').closest('th')?.style.backgroundColor).toBe('');
  });

  it('gives the master column no tooltip on a row only a later plugin holds', async () => {
    renderPanel(compareResultFixture({
      overrides: columns.slice(0, 2).map(plugin => compareOverride({
        formKey: '000001:Fallout4.esm', plugin, editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'x' }],
      })),
      diffs: [diffNode({
        fieldName: 'Name', values: { 'Same.esp': 'Added' }, winnerColumn: 'Same.esp',
        cellStates: { 'Same.esp': 'Override' }, conflictAll: 'Override',
      })],
    }));
    await cellOf('Added');
    const masterCell = screen.getByText('Name').closest('tr')?.querySelectorAll('td')[1];
    expect(masterCell?.title).toBe('');
  });

  it('names a lone copy Single Record', async () => {
    renderPanel(compareResultFixture({
      overrides: [compareOverride({
        formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: true,
        editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'x' }],
      })],
      diffs: [diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Only' }, winnerColumn: 'Fallout4.esm', conflictAll: 'OnlyOne' })],
    }));
    expect((await cellOf('Only')).title).toBe('Single Record');
  });
});

describe('RecordPanel — postMessage wiring', () => {
  const fkPlugins = [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }];

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('posts nothing when a FormKey link is Ctrl+clicked: go to record is the menu\'s', async () => {
    renderPanel(fkCompareResult, { plugins: fkPlugins });
    await waitFor(() => screen.getByText('HumanRace [00013918:Fallout4.esm]'));
    vi.mocked(vscode.postMessage).mockClear();
    fireEvent.click(screen.getByText('HumanRace [00013918:Fallout4.esm]'), { ctrlKey: true });
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openRecord' }));
  });

  it('re-loads with the new formKey when a loadRecord message arrives from the extension', async () => {
    const { client } = renderPanel(fkCompareResult, { plugins: fkPlugins });
    await screen.findByText('Non-Player Character TestNPC [000001:Fallout4.esm]');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(client.load).toHaveBeenCalledWith('000002:Fallout4.esm'));
  });
});

describe('RecordPanel — struct sub-rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('a struct row opens expanded, its children shown beneath a ▼ arrow', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument());
    expect(screen.getByText('Y')).toBeInTheDocument();
    expect(within(required(screen.getByText('Bounds').closest('tr'), 'the Bounds row')).getByText('▼')).toBeInTheDocument();
  });

  it('a click on a row\'s arrow focuses its label as it collapses the row, as a tree\'s twistie selects its row', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));

    fireEvent.click(within(required(screen.getByText('Bounds').closest('tr'), 'the Bounds row')).getByText('▼'));

    expect(screen.queryByText('X')).not.toBeInTheDocument();
    expect(screen.getByText('Bounds').closest('td')).toHaveAttribute('data-focused-cell');
  });

  it('double clicking the label collapses an expanded row and expands it again', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));

    fireEvent.doubleClick(screen.getByText('Bounds'));
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('Bounds'));
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('child row for X shows each override\'s own sub-field value, the master\'s beside the override\'s: the delta struct expansion exists to show', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('the arrow beside the label collapses the child rows, and expands them again', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));
    const boundsRow = () => required(screen.getByText('Bounds').closest('tr'), "the Bounds row");

    fireEvent.click(within(boundsRow()).getByText('▼'));
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    expect(screen.getAllByText('{…}').length).toBeGreaterThan(0);

    fireEvent.click(within(boundsRow()).getByText('▶'));
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('a double click on the arrow toggles the row once for each of its two clicks', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));

    const arrow = within(required(screen.getByText('Bounds').closest('tr'), 'the Bounds row')).getByText('▼');
    fireEvent.click(arrow);
    fireEvent.click(arrow);
    fireEvent.doubleClick(arrow);

    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('child row X has correct cell background from cellStates (Override = green)', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('15'));
    const cell = screen.getByText('15').closest('td');
    if (!cell) throw new Error('expected a td ancestor of the child row\'s 15 cell');
    expect(cell.style.backgroundColor).toBe('var(--vscode-modbench-conflictOverride)');
  });
});

describe('RecordPanel — keys through the rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  const labelCell = (text: string) => required(screen.getByText(text).closest('td'), `the ${text} label cell`);
  const focusedCells = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-focused-cell]'));
  const press = (cell: Element, key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(cell, { key, ...init });

  async function focusedOn(text: string, opts: PanelOpts = {}, result: CompareResult = structCompareResult) {
    const rendered = renderPanel(result, opts);
    await waitFor(() => screen.getByText(text));
    const cell = labelCell(text);
    fireEvent.click(cell);
    return { ...rendered, cell };
  }

  it('Down and Up move the focus a row, through the expanded children', async () => {
    const { container, cell } = await focusedOn('Bounds');

    press(cell, 'ArrowDown');
    expect(focusedCells(container)).toEqual([labelCell('X')]);

    press(labelCell('X'), 'ArrowDown');
    expect(focusedCells(container)).toEqual([labelCell('Y')]);

    press(labelCell('Y'), 'ArrowUp');
    expect(focusedCells(container)).toEqual([labelCell('X')]);
  });

  it('Home and End move the focus to the first and last row', async () => {
    const { container, cell } = await focusedOn('Bounds');

    press(cell, 'End');
    expect(focusedCells(container)).toEqual([labelCell('Y')]);

    press(labelCell('Y'), 'Home');
    expect(focusedCells(container)).toEqual([labelCell('Record Header')]);
  });

  it('Left collapses an expanded row and Right expands it again', async () => {
    const { container, cell } = await focusedOn('Bounds');

    press(cell, 'ArrowLeft');
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    expect(focusedCells(container)).toEqual([labelCell('Bounds')]);

    press(labelCell('Bounds'), 'ArrowRight');
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('Right on an expanded row steps into its first child, and Left steps back out to the parent', async () => {
    const { container, cell } = await focusedOn('Bounds');

    press(cell, 'ArrowRight');
    expect(focusedCells(container)).toEqual([labelCell('X')]);

    press(labelCell('X'), 'ArrowLeft');
    expect(focusedCells(container)).toEqual([labelCell('Bounds')]);
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('on a value column, Left and Right move a column and Down keeps the column', async () => {
    const { container } = await focusedOn('Bounds');
    const valueCell = required(screen.getByText('15').closest('td'), 'the winner\'s X cell');
    const masterCell = required(screen.getByText('10').closest('td'), 'the master\'s X cell');
    fireEvent.click(masterCell);

    press(masterCell, 'ArrowRight');
    expect(focusedCells(container)).toEqual([valueCell]);
    expect(screen.getByText('X')).toBeInTheDocument();

    press(valueCell, 'ArrowDown');
    const yRow = required(screen.getByText('Y').closest('tr'), 'the Y row');
    expect(focusedCells(container)).toEqual([yRow.children[2]]);

    press(required(yRow.children[2], 'the winner\'s Y cell'), 'ArrowLeft');
    expect(focusedCells(container)).toEqual([yRow.children[1]]);
  });

  it('tells the host the user entered the grid when a key moves the focus', async () => {
    const { cell } = await focusedOn('Bounds');
    vi.mocked(vscode.postMessage).mockClear();

    press(cell, 'ArrowDown');

    await waitFor(() => expect(vi.mocked(vscode.postMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.FOCUS_CELL, entered: true })));
  });

  it('moves no focus on a key with a modifier, which is another gesture\'s', async () => {
    const { container, cell } = await focusedOn('Bounds');

    press(cell, 'ArrowDown', { ctrlKey: true });
    press(cell, 'ArrowDown', { altKey: true });

    expect(focusedCells(container)).toEqual([cell]);
  });

  it('acts on no key while an editor is open, where the keys edit its text', async () => {
    const { container } = await focusedOn('Name', { plugins: trackedMyModPluginsForTheRealEditableColumnsGate }, flagsCompareResult);
    const valueCell = required(screen.getByText('Override Name').closest('td'), 'the editable Name cell');
    fireEvent.click(valueCell);
    fireEvent.doubleClick(valueCell);
    const editor = screen.getByRole('textbox');

    press(editor, 'ArrowDown');
    press(editor, 'ArrowLeft');
    press(editor, 'Home');

    expect(focusedCells(container)).toEqual([valueCell]);
  });
});

describe('RecordPanel — a plugin mEdit cannot read', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says it shows the last good read, with the reason, when a plugin the panel shows cannot be read', async () => {
    renderPanel(compareResult, { loadFailures: [{ name: 'MyMod.esp', origin: 'Data/', reason: 'truncated' }] });
    await waitFor(() => screen.getByText('Showing the last good read: MyMod.esp: truncated'));
  });

  it('says nothing of a plugin the panel does not show', async () => {
    renderPanel(compareResult, { loadFailures: [{ name: 'Elsewhere.esp', origin: 'Data/', reason: 'truncated' }] });
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
    expect(screen.queryByText(/Showing the last good read/)).not.toBeInTheDocument();
  });

  it('goes once a read lands with the plugin readable again', async () => {
    const answered = (loadFailures: PluginLoadFailure[]) => ({
      ok: true as const, result: compareResult, immutableSet: new Set<string>(), trackedSet: new Set<string>(),
      sourceUnreadableSet: new Set<string>(),
      modsByOrigin: {},
      conflictsComputed: true, loadFailures,
    });
    const load = vi.fn()
      .mockResolvedValueOnce(answered([{ name: 'MyMod.esp', origin: 'Data/', reason: 'truncated' }]))
      .mockResolvedValue(answered([]));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText(/Showing the last good read/));

    loadRecord();

    await waitFor(() => expect(screen.queryByText(/Showing the last good read/)).not.toBeInTheDocument());
  });
});

describe('RecordPanel — incomplete-comparison banner', () => {
  const incompleteMessage = recordPanelIncompleteMessage(false);
  if (!incompleteMessage) throw new Error('expected a banner message when conflicts are not yet computed');

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('states the comparison is incomplete when opened while the winner sweep is outstanding', async () => {
    renderPanel(compareResult, { conflictsComputed: false });
    await waitFor(() => screen.getByText(incompleteMessage));
  });

  it('shows no statement once the sweep has already completed', async () => {
    renderPanel(compareResult, { conflictsComputed: true });
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
    expect(screen.queryByText(incompleteMessage)).not.toBeInTheDocument();
  });

  it('a panel already open when the sweep lands reads again and reflects settled data, not just clears its banner over stale content', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        modsByOrigin: {}, immutableSet: new Set(), conflictsComputed: false, loadFailures: [],
      })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        modsByOrigin: {}, immutableSet: new Set(), conflictsComputed: true, loadFailures: [],
      });
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText(incompleteMessage));

    loadRecord();

    await waitFor(() => expect(screen.queryByText(incompleteMessage)).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('RecordPanel — LOAD_RECORD state management', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('re-loads data when LOAD_RECORD arrives with the same formKey', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
    const callsBefore = vi.mocked(client.load).mock.calls.length;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(vi.mocked(client.load).mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
  });

  it('clears error and shows data after a successful refresh following a load failure', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        modsByOrigin: {}, immutableSet: new Set(['Fallout4.esm']), conflictsComputed: true, loadFailures: [],
      });
    renderPanel(compareResult, { load });
    await waitFor(() => expect(screen.getByText('Failed to load: HTTP 500')).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument());
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
  });

  it('shows "Failed to load:" and the reason the page was given when no record could be read for its tab, and reads nothing', () => {
    vi.stubGlobal('mEditFormKey', undefined);
    vi.stubGlobal('mEditLoadError', 'Gun.json declares no FormKey.');
    const { client } = renderPanel(compareResult);

    expect(screen.getByText('Failed to load: Gun.json declares no FormKey.')).toBeInTheDocument();
    expect(client.load).not.toHaveBeenCalled();
  });
});

const loaded = (result: CompareResult | null, conflictsComputed = true, gone = ['000001:Fallout4.esm'], copiesLacking: string[] = []) => ({
  ok: true as const, ...(result === null ? { result, gone, copiesLacking } : { result }), immutableSet: new Set<string>(), trackedSet: new Set<string>(), sourceUnreadableSet: new Set<string>(), modsByOrigin: {}, conflictsComputed, loadFailures: [],
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const sendMessage = (data: unknown) => {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
};

const loadRecord = (formKey = '000001:Fallout4.esm') =>
  sendMessage({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey });

describe('RecordPanel — states', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an empty panel until the first read lands', () => {
    const { container } = renderPanel(compareResult, { load: () => new Promise(() => undefined) });
    expect(container).toHaveTextContent('');
  });

  it('keeps the grid, with the rows I collapsed, while the record is read again', async () => {
    const pending = deferred<ReturnType<typeof loaded>>();
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(structCompareResult))
      .mockReturnValueOnce(pending.promise);
    renderPanel(structCompareResult, { load });
    await waitFor(() => screen.getByText('Bounds'));
    const boundsRow = required(screen.getByText('Bounds').closest('tr'), 'the Bounds row');
    fireEvent.click(within(boundsRow).getByText('▼'));

    loadRecord();

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Bounds').closest('tr')).toBe(boundsRow);
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    pending.resolve(loaded(structCompareResult));
    await waitFor(() => screen.getByText('▶', { selector: 'button' }));
    expect(screen.queryByText('X')).not.toBeInTheDocument();
  });

  it('keeps the grid and the focused cell while it reads the record under the FormKey it moved to', async () => {
    const pending = deferred<ReturnType<typeof loaded>>();
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(structCompareResult))
      .mockReturnValueOnce(pending.promise);
    const { container } = renderPanel(structCompareResult, { load });
    await waitFor(() => screen.getByText('Bounds'));
    const focused = required(screen.getByText('Bounds').closest('td'), 'the Bounds label cell');
    fireEvent.click(focused);

    loadRecord('000002:Fallout4.esm');

    await waitFor(() => expect(load).toHaveBeenLastCalledWith('000002:Fallout4.esm'));
    expect(screen.getByText('Bounds').closest('td')).toBe(focused);
    pending.resolve(loaded(structCompareResult));
    await act(async () => { await Promise.resolve(); });
    expect(Array.from(container.querySelectorAll('[data-focused-cell]'))).toEqual([screen.getByText('Bounds').closest('td')]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('says the record is gone, naming it, in place of the grid', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(compareResult))
      .mockResolvedValue(loaded(null));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText('Override Name'));

    loadRecord();

    await waitFor(() => screen.getByText('000001:Fallout4.esm is gone.'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
  });

  it('names every record that is gone, not only the tab\'s own', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(compareResult))
      .mockResolvedValue(loaded(null, true, ['000777:Column.esm', '000778:Column.esm']));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText('Override Name'));

    loadRecord();

    await waitFor(() => screen.getByText('000777:Column.esm, 000778:Column.esm are gone.'));
  });

  it('says what mEdit said of a copy only its plugin lacks, beside the gone record', async () => {
    const load = vi.fn().mockResolvedValue(loaded(null, true, ['000777:Column.esm'], ['000778:Column.esm is not in B.esp (ModB).']));
    renderPanel(compareResult, { load });

    await waitFor(() => screen.getByText('000777:Column.esm is gone. 000778:Column.esm is not in B.esp (ModB).'));
  });

  it('says the last read failed, beside the gone record, until a good read replaces it', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(null))
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
      .mockResolvedValue(loaded(compareResult));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText('000001:Fallout4.esm is gone.'));

    loadRecord();
    await waitFor(() => screen.getByText('000001:Fallout4.esm is gone. The last read failed: HTTP 500'));

    loadRecord();
    await waitFor(() => screen.getByText('Override Name'));
  });

  it('shows the record again when a later read finds it', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(null))
      .mockResolvedValue(loaded(compareResult));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText('000001:Fallout4.esm is gone.'));

    loadRecord();

    await waitFor(() => screen.getByText('Override Name'));
    expect(screen.queryByText(/is gone/)).not.toBeInTheDocument();
  });

  it('keeps the rows and says "Showing the last good read:" when a later read fails, until the next good one', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(loaded(compareResult))
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
      .mockResolvedValue(loaded(compareResult));
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText('Override Name'));

    loadRecord();
    await waitFor(() => screen.getByText('Showing the last good read: HTTP 500'));
    expect(screen.getByText('Override Name')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();

    loadRecord();
    await waitFor(() => expect(screen.queryByText(/Showing the last good read/)).not.toBeInTheDocument());
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('lets a newer read win when an older one answers after it', async () => {
    const older = deferred<ReturnType<typeof loaded>>();
    const newer = deferred<ReturnType<typeof loaded>>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    renderPanel(compareResult, { load });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    loadRecord();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    newer.resolve(loaded(compareResult));
    await waitFor(() => screen.getByText('Override Name'));
    older.resolve(loaded(null));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Override Name')).toBeInTheDocument();
    expect(screen.queryByText(/is gone/)).not.toBeInTheDocument();
  });
});

describe('RecordPanel — column collapse', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  const collapseButton = (plugin: string) => within(required(screen.getByText(plugin).closest('th'), 'the column\u2019s header')).getByRole('button');

  it('the button in a plugin column header collapses that column, hiding its field values while the chip itself stays visible', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(collapseButton('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
  });

  it('the button of a collapsed column expands it again', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(collapseButton('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    fireEvent.click(collapseButton('MyMod.esp'));
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('a click on a column header away from its button collapses nothing', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('collapsed column header hides the (read-only) label', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('(read-only)'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();

    fireEvent.click(collapseButton('Fallout4.esm'));
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
  });

  it('collapsed state survives a read of the record under the FormKey it moved to', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(collapseButton('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
  });
});

describe('RecordPanel — the place a tab keeps, carried to the tab a move of its file opens', () => {
  beforeEach(() => { vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'); vi.mocked(vscode.postMessage).mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  const scroller = (container: HTMLElement) => required(container.querySelector<HTMLElement>('div[style*="overflow: auto"]'), 'the grid’s scroller');
  const toldPlaces = () => vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message)
    .filter(message => message.type === WEBVIEW_TO_EXTENSION.VIEW_STATE);
  const place = { collapsedRows: [], collapsedColumns: [], focusedCell: null, scroll: { top: 0, left: 0 } };

  it('opens with the columns collapsed, the focused cell and the scroll the tab had', async () => {
    vi.stubGlobal('mEditViewState', {
      ...place, collapsedColumns: ['MyMod.esp'], focusedCell: { rowKey: 'Name', plugin: null }, scroll: { top: 40, left: 12 },
    });
    const { container } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));

    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    expect(screen.getByText('Name').closest('td')).toHaveAttribute('data-focused-cell');
    expect([scroller(container).scrollTop, scroller(container).scrollLeft]).toEqual([40, 12]);
  });

  it('opens with the rows collapsed that the tab had collapsed', async () => {
    vi.stubGlobal('mEditViewState', { ...place, collapsedRows: ['Bounds'] });
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('Bounds'));

    expect(screen.queryByText('X')).not.toBeInTheDocument();
  });

  it('tells the host its place each time it changes, and not before', async () => {
    const { container } = renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));
    expect(toldPlaces()).toEqual([]);

    fireEvent.click(screen.getByText('Bounds'));
    fireEvent.doubleClick(screen.getByText('Bounds'));
    scroller(container).scrollTop = 30;
    fireEvent(scroller(container), new Event('scrollend'));

    expect(toldPlaces().at(-1)).toEqual({
      type: WEBVIEW_TO_EXTENSION.VIEW_STATE,
      state: { ...place, collapsedRows: ['Bounds'], focusedCell: { rowKey: 'Bounds', plugin: null }, scroll: { top: 30, left: 0 } },
    });
  });
});

describe('RecordPanel — column widths: a column\'s header and every cell under it share one width', () => {
  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  const widthsOfColumn = (index: number) => Array.from(document.querySelectorAll('tr'))
    .map(row => row.children[index])
    .filter((cell): cell is HTMLElement => cell instanceof HTMLElement)
    .map(cell => cell.style.width);

  function dragEdge(header: HTMLElement, from: number, by: number) {
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, from, 20));
    fireEvent.mouseDown(required(header.querySelector('[data-column-edge]'), 'the header\u2019s edge'), { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: by });
    fireEvent.mouseUp(window, { clientX: by });
  }

  it('collapses a column to a narrow strip, header and cells alike', async () => {
    renderPanel(compareResult);
    await screen.findByText('Override Name');

    fireEvent.click(within(required(screen.getByText('MyMod.esp').closest('th'), 'the header')).getByRole('button'));

    expect(new Set(widthsOfColumn(2))).toEqual(new Set(['48px']));
    expect(new Set(widthsOfColumn(1))).toEqual(new Set(['']));
  });

  it('gives a plugin column the width its edge is dragged to, header and cells alike', async () => {
    renderPanel(compareResult);
    await screen.findByText('Override Name');

    dragEdge(required(screen.getByText('MyMod.esp').closest('th'), 'the column\u2019s header'), 200, 40);

    expect(new Set(widthsOfColumn(2))).toEqual(new Set(['240px']));
    expect(new Set(widthsOfColumn(1))).toEqual(new Set(['']));
  });

  function borderBoxWidthOf(cell: HTMLElement): number {
    const style = getComputedStyle(cell);
    const outside = style.boxSizing === 'border-box' ? 0
      : [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
        .reduce((sum, length) => sum + (parseFloat(length) || 0), 0);
    return parseFloat(style.width) + outside;
  }

  it('keeps a column\u2019s width through a drag of its edge that does not move', async () => {
    renderPanel(compareResult);
    await screen.findByText('Override Name');
    const header = required(screen.getByText('MyMod.esp').closest('th'), 'the column\u2019s header');
    dragEdge(header, 200, 40);

    dragEdge(header, borderBoxWidthOf(header), 0);

    expect(new Set(widthsOfColumn(2))).toEqual(new Set(['240px']));
  });

  it('gives the label column the width its edge is dragged to', async () => {
    renderPanel(compareResult);
    await screen.findByText('Override Name');

    dragEdge(required(screen.getByText('Field').closest('th'), 'the label column\u2019s header'), 160, -40);

    expect(new Set(widthsOfColumn(0))).toEqual(new Set(['120px']));
  });
});

const intSubMeta = (name: string): FieldMetadata =>
  (fieldMeta({ name, type: 'int' }));

const aliasSubMeta = (name: string, leaf: string): FieldMetadata => fieldMeta({
  name, type: 'struct', fields: [intSubMeta('alias_id')],
  variants: { [leaf]: fieldMeta({ name, type: 'struct', fields: [intSubMeta('alias_id')] }) }});

const aliasesMeta: FieldMetadata = fieldMeta({
  name: 'aliases', type: 'array', isArray: true,
  elementType: fieldMeta({
    name: '', type: 'struct',
    fields: [
      fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }),
      fieldMeta({ name: 'name', type: 'string' }),
      aliasSubMeta('location', 'RefAlias'),
      aliasSubMeta('external', 'LocAlias'),
    ]})});

const masterAlias = { Kind: 'RefAlias', name: 'AnAlias', location: { alias_id: 5 }, external: null };
const overrideAlias = { Kind: 'LocAlias', name: 'AnAlias', location: null, external: { alias_id: 7 } };

const mixedLeafAliasResult: CompareResult = compareResultFixture({
  conflictAll: 'Conflict',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
      editorId: 'TestQuest', fields: [{ metadata: aliasesMeta, value: [masterAlias] }], conflictThis: 'Master',
    }),
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestQuest', fields: [{ metadata: aliasesMeta, value: [overrideAlias] }], conflictThis: 'ConflictWins',
    }),
  ],
  diffs: [diffNode({
    fieldName: 'aliases',
    values: { 'Fallout4.esm': [masterAlias], 'MyMod.esp': [overrideAlias] },
    winnerColumn: 'MyMod.esp', cellStates: {},
    children: [diffNode({
      fieldName: '[0]',
      values: { 'Fallout4.esm': masterAlias, 'MyMod.esp': overrideAlias },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        diffNode({
          fieldName: 'name', values: { 'Fallout4.esm': 'AnAlias', 'MyMod.esp': 'AnAlias' },
          winnerColumn: 'MyMod.esp', cellStates: {},
        }),
        diffNode({
          fieldName: 'location',
          values: { 'Fallout4.esm': { alias_id: 5 }, 'MyMod.esp': null },
          winnerColumn: 'Fallout4.esm', cellStates: {},
          children: [diffNode({
            fieldName: 'alias_id', values: { 'Fallout4.esm': 5, 'MyMod.esp': null },
            winnerColumn: 'Fallout4.esm', cellStates: {},
          })],
        }),
        diffNode({
          fieldName: 'external',
          values: { 'Fallout4.esm': null, 'MyMod.esp': { alias_id: 7 } },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [diffNode({
            fieldName: 'alias_id', values: { 'Fallout4.esm': null, 'MyMod.esp': 7 },
            winnerColumn: 'MyMod.esp', cellStates: {},
          })],
        }),
      ],
    })],
  })],
});

const mixedLeafAliasDiff = required(mixedLeafAliasResult.diffs[0], "the sole diff of mixedLeafAliasResult");
const mixedLeafAliasDiffChildren = required(mixedLeafAliasDiff.children, "the sole diff's children");
const mixedLeafAliasDiffChild = required(mixedLeafAliasDiffChildren[0], "the sole diff's first child");
const mixedLeafAliasDiffChildChildren = required(
  mixedLeafAliasDiffChild.children, "the first child's own children",
);

const singleLeafAliasResult: CompareResult = compareResultFixture({
  ...mixedLeafAliasResult,
  overrides: mixedLeafAliasResult.overrides.map(o => compareOverride({ ...o, fields: [{ metadata: aliasesMeta, value: [masterAlias] }] })),
  diffs: [diffNode({
    ...mixedLeafAliasDiff,
    values: { 'Fallout4.esm': [masterAlias], 'MyMod.esp': [masterAlias] },
    children: [diffNode({
      ...mixedLeafAliasDiffChild,
      values: { 'Fallout4.esm': masterAlias, 'MyMod.esp': masterAlias },
      children: mixedLeafAliasDiffChildChildren
        .filter(c => c.fieldName !== 'external')
        .map(c => (c.fieldName === 'location'
          ? diffNode({ ...c, values: { 'Fallout4.esm': { alias_id: 5 }, 'MyMod.esp': { alias_id: 5 } } })
          : c)),
    })],
  })],
});

const gridBodyRowsNotHeaderLoadIndexes = () => within(required(screen.getByRole('table').querySelector('tbody'), "the table's tbody"));
const cellsOf = (label: string) => required(gridBodyRowsNotHeaderLoadIndexes().getByText(label).closest('tr'), `the '${label}' row`).querySelectorAll('td');
const cellAt = (label: string, index: number) => required(cellsOf(label)[index], `the '${label}' row's cell ${index}`);

describe('RecordPanel — union element rows: two plugins can disagree on which leaf of an abstract union an element is, so the rows are both leaves\' members, which a member\'s `variants`, read through the element\'s discriminator, name', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function labelCell(label: string): HTMLElement {
    return required(gridBodyRowsNotHeaderLoadIndexes().getByText(label).closest('td'), `the '${label}' cell's td ancestor`);
  }

  async function renderElement() {
    renderPanel(mixedLeafAliasResult);
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('aliases'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('[0]'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('location'));
  }

  it('shows the union of both plugins\' leaf members', async () => {
    await renderElement();
    expect(gridBodyRowsNotHeaderLoadIndexes().getByText('name')).toBeInTheDocument();
    expect(gridBodyRowsNotHeaderLoadIndexes().getByText('location')).toBeInTheDocument();
    expect(gridBodyRowsNotHeaderLoadIndexes().getByText('external')).toBeInTheDocument();
  });

  it('renders an empty cell for the column whose leaf lacks the member', async () => {
    await renderElement();
    fireEvent.click(required(labelCell('location').querySelector('button'), "the 'location' row's arrow"));
    fireEvent.click(required(labelCell('external').querySelector('button'), "the 'external' row's arrow"));
    const locationRow = required(labelCell('location').closest('tr'), "the 'location' row");
    const locationCells = locationRow.querySelectorAll('td');
    expect(required(locationCells[1], "the 'location' row's second cell").textContent).toBe('{…}');
    expect(required(locationCells[2], "the 'location' row's third cell").textContent).toBe('');

    const externalRow = required(labelCell('external').closest('tr'), "the 'external' row");
    const externalCells = externalRow.querySelectorAll('td');
    expect(required(externalCells[1], "the 'external' row's second cell").textContent).toBe('');
    expect(required(externalCells[2], "the 'external' row's third cell").textContent).toBe('{…}');
  });

  it('shows no row for a member no plugin\'s leaf declares, an element\'s rows being the ones its own plugins carry rather than one per schema member, as the backend drops a member null in every column', async () => {
    renderPanel(singleLeafAliasResult);
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('aliases'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('[0]'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('location'));
    expect(gridBodyRowsNotHeaderLoadIndexes().queryByText('external')).not.toBeInTheDocument();
  });

  it('indents each nesting level by its own depth', async () => {
    await renderElement();
    expect(labelCell('aliases')).not.toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('[0]')).toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('location')).toHaveStyle({ paddingLeft: '48px' });

    for (const aliasId of gridBodyRowsNotHeaderLoadIndexes().getAllByText('alias_id')) {
      expect(aliasId.closest('td')).toHaveStyle({ paddingLeft: '72px' });
    }
  });
});

const unionFieldMeta: FieldMetadata = fieldMeta({
  name: 'Level',
  type: 'struct',
  fields: [
    fieldMeta({ name: 'level', type: 'int' }),
    fieldMeta({
      name: 'MutagenObjectType', type: 'enum',
      enumMembers: [{ value: 'NpcLevel', label: 'Npc Level' },
        { value: 'PcLevelMult', label: 'Pc Level Mult' }],
      displayLabel: 'Kind'}),
  ]});

const unionValue = { level: 5, MutagenObjectType: 'NpcLevel' };

const unionCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'OnlyOne',
  overrides: [
    compareOverride({
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: unionFieldMeta, value: unionValue }],
      conflictThis: 'OnlyOne',
    }),
  ],
  diffs: [
    diffNode({
      fieldName: 'Level',
      values: { 'MyMod.esp': unionValue },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        diffNode({
          fieldName: 'level', values: { 'MyMod.esp': 5 },
          winnerColumn: 'MyMod.esp', cellStates: {},
        }),
        diffNode({
          fieldName: 'MutagenObjectType', values: { 'MyMod.esp': 'NpcLevel' },
          winnerColumn: 'MyMod.esp', cellStates: {},
        }),
      ],
    }),
  ],
});

const unionTrackedPluginsResponse = [
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true },
];

describe('RecordPanel — an abstract union\'s leaf is an editable field, a Mutagen class name being a wire token the user is never shown: the panel displays the reflector\'s labels and posts the values', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  async function renderLevel() {
    renderPanel(unionCompareResult, { plugins: unionTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Level')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Kind')).toBeInTheDocument());
  }

  it('labels the row from the schema and never shows the class name it holds', async () => {
    await renderLevel();

    expect(screen.queryByText('MutagenObjectType')).not.toBeInTheDocument();
    expect(screen.getByText('Npc Level')).toBeInTheDocument();
    expect(screen.queryByText('NpcLevel')).not.toBeInTheDocument();
  });

  it('opens a dropdown of the union\'s leaves, listed by label', async () => {
    await renderLevel();

    fireEvent.doubleClick(screen.getByText('Npc Level'));

    const options = within(screen.getByRole('combobox')).getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['Npc Level', 'Pc Level Mult']);
  });

  it('posts set of the discriminator member carrying the chosen leaf\'s own wire value, not its label, a discriminator switch being the Kind row\'s own set while the backend switches the leaf', async () => {
    await renderLevel();
    fireEvent.doubleClick(screen.getByText('Npc Level'));
    vi.mocked(vscode.postMessage).mockClear();

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'PcLevelMult' } });
    fireEvent.blur(select);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: {
        op: 'set',
        path: [{ kind: 'member', name: 'Level' }, { kind: 'member', name: 'MutagenObjectType' }],
        value: 'PcLevelMult',
      },
    }));
  });
});

describe('RecordPanel — an absent member reads as its default, the document omitting a member equal to its default, while "—" is kept for a member whose metadata says null is a value', () => {
  const statsMeta: FieldMetadata = fieldMeta({
    name: 'Stats', type: 'struct',
    fields: [
      fieldMeta({ name: 'Weight', type: 'int' }),
      fieldMeta({ name: 'Essential', type: 'bool' }),
      fieldMeta({ name: 'Prefix', type: 'string' }),
      fieldMeta({
        name: 'RunOn', type: 'enum', default: 'Subject',
        enumMembers: [{ value: 'Subject' }, { value: 'Target' }]}),
      fieldMeta({ name: 'Count', type: 'int', default: 100 }),
      fieldMeta({ name: 'Owner', type: 'formKey', validFormKeyTypes: ['NPC_'], allowsNull: true }),
    ]});
  const full = { Weight: 3, Essential: true, Prefix: 'x', RunOn: 'Target', Count: 7, Owner: '000019:Fallout4.esm' };
  const sparse = {};

  const compare: CompareResult = compareResultFixture({
    conflictAll: 'Conflict',
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false,
        editorId: 'TestNPC', fields: [{ metadata: statsMeta, value: full }], conflictThis: 'Master' }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
        editorId: 'TestNPC', fields: [{ metadata: statsMeta, value: sparse }], conflictThis: 'ConflictWins' }),
    ],
    diffs: [diffNode({
      fieldName: 'Stats', values: { 'Fallout4.esm': full, 'MyMod.esp': sparse },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: Object.entries(full).map(([name, v]) => diffNode({
        fieldName: name, values: { 'Fallout4.esm': v, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
      })),
    })],
  });

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderExpanded() {
    renderPanel(compare, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Stats'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Weight'));
  }

  it('an absent int reads 0, an absent bool false, an absent string empty', async () => {
    await renderExpanded();
    expect(cellAt('Weight', 2).textContent).toBe('0');
    expect(cellAt('Essential', 2).textContent).toBe('False');
    expect(cellAt('Prefix', 2).textContent).toBe('');
    expect(gridBodyRowsNotHeaderLoadIndexes().queryAllByText('—')).toHaveLength(1);
  });

  it('an absent enum reads the default the metadata names', async () => {
    await renderExpanded();
    expect(cellAt('RunOn', 2).textContent).toBe('Subject');
  });

  it('an absent scalar with a declared default reads that default', async () => {
    await renderExpanded();
    expect(cellAt('Count', 2).textContent).toBe('100');
  });

  it('an unset nullable link reads as empty', async () => {
    await renderExpanded();
    expect(cellAt('Owner', 2).textContent).toBe('—');
  });

  it('editing an absent int from its default posts one set with the typed value, the default being what the editor opens on so a value equal to it is no edit at all', async () => {
    await renderExpanded();
    vi.mocked(vscode.postMessage).mockClear();
    const cell = cellAt('Weight', 2);
    fireEvent.doubleClick(within(cell).getByText('0'));
    const input = required(cell.querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Stats' }, { kind: 'member', name: 'Weight' }], value: 5 },
    }));
  });
});

describe('RecordPanel — a member of an absent owner reads as nothing, not as zero: it is not absent-by-default, there being nothing for it to be a member of', () => {
  const boundsMeta: FieldMetadata = fieldMeta({
    name: 'Bounds', type: 'struct', allowsNull: true,
    fields: [fieldMeta({ name: 'X', type: 'int' })]});
  const valuesMeta: FieldMetadata = fieldMeta({
    name: 'Values', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' })});
  const compare: CompareResult = compareResultFixture({
    conflictAll: 'Conflict',
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: boundsMeta, value: { X: 10 } }, { metadata: valuesMeta, value: [1, 2] }], conflictThis: 'Master' }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: boundsMeta, value: null }, { metadata: valuesMeta, value: [1] }], conflictThis: 'ConflictWins' }),
    ],
    diffs: [
      diffNode({
        fieldName: 'Bounds', values: { 'Fallout4.esm': { X: 10 }, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [diffNode({ fieldName: 'X', values: { 'Fallout4.esm': 10, 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {} })],
      }),
      diffNode({
        fieldName: 'Values', values: { 'Fallout4.esm': [1, 2], 'MyMod.esp': [1] },
        winnerColumn: 'MyMod.esp', cellStates: {},
        children: [
          diffNode({ fieldName: '[0]', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} }),
          diffNode({ fieldName: '[1]', values: { 'Fallout4.esm': 2, 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {} }),
        ],
      }),
    ],
  });

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('an unset nullable struct reads as empty, and its member as nothing rather than zero', async () => {
    renderPanel(compare, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Bounds'));
    expect(cellAt('Bounds', 2).textContent).toBe('');
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('X'));

    expect(cellAt('X', 1).textContent).toBe('10');
    expect(cellAt('X', 2).textContent).toBe('');
  });

  it('an element past the column\'s own length reads as nothing, not zero', async () => {
    renderPanel(compare, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Values'));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('[1]'));

    expect(cellAt('[1]', 1).textContent).toBe('2');
    expect(cellAt('[1]', 2).textContent).toBe('');
  });

  it('a Partial Form column\'s fields read as nothing, the classifier nulling every field so none is absent-by-default', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Name'));
    expect(cellAt('Name', 1).textContent).toBe('Original Name');
    expect(cellAt('Name', 2).textContent).toBe('');
  });

  it('a Partial Form column\'s non-nullable struct field, whose absence would otherwise read as its default, reads as nothing, not as its default', async () => {
    const sizeMeta: FieldMetadata = fieldMeta({
      name: 'Size', type: 'struct', fields: [fieldMeta({ name: 'Width', type: 'int' })]});
    renderPanel(compareResultFixture({
      ...partialFormCompareResult,
      overrides: partialFormCompareResult.overrides.map((o, i) => ({
        ...o, fields: [{ metadata: sizeMeta, value: i === 0 ? { Width: 3 } : null }],
      })),
      diffs: [diffNode({
        fieldName: 'Size', values: { 'Fallout4.esm': { Width: 3 }, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [diffNode({
          fieldName: 'Width', values: { 'Fallout4.esm': 3, 'MyMod.esp': null },
          winnerColumn: 'Fallout4.esm', cellStates: {},
        })],
      })],
    }), { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Size'));
    fireEvent.click(required(required(gridBodyRowsNotHeaderLoadIndexes().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
    expect(cellAt('Size', 1).textContent).toBe('{…}');
    expect(cellAt('Size', 2).textContent).toBe('');

    fireEvent.click(required(required(gridBodyRowsNotHeaderLoadIndexes().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Width'));
    expect(cellAt('Width', 2).textContent).toBe('');
  });
});

describe('RecordPanel — an absent non-nullable struct reads as its default members, as it has no "unset" so the column that omits it holds that struct at its defaults, member by member', () => {
  const sizeMeta: FieldMetadata = fieldMeta({
    name: 'Size', type: 'struct',
    fields: [
      fieldMeta({ name: 'Width', type: 'int' }),
      fieldMeta({ name: 'Label', type: 'string' }),
      fieldMeta({ name: 'Depth', type: 'int', default: 12 }),
    ]});
  const full = { Width: 3, Label: 'x', Depth: 7 };
  const compare: CompareResult = compareResultFixture({
    conflictAll: 'Conflict',
    overrides: [
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: sizeMeta, value: full }], conflictThis: 'Master' }),
      compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: sizeMeta, value: null }], conflictThis: 'ConflictWins' }),
    ],
    diffs: [diffNode({
      fieldName: 'Size', values: { 'Fallout4.esm': full, 'MyMod.esp': null },
      winnerColumn: 'Fallout4.esm', cellStates: {},
      children: Object.entries(full).map(([name, v]) => diffNode({
        fieldName: name, values: { 'Fallout4.esm': v, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
      })),
    })],
  });

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderExpanded() {
    renderPanel(compare, { plugins: trackedMyModPluginsForTheRealEditableColumnsGate });
    await waitFor(() => gridBodyRowsNotHeaderLoadIndexes().getByText('Width'));
  }

  async function renderCollapsed() {
    await renderExpanded();
    fireEvent.click(required(required(gridBodyRowsNotHeaderLoadIndexes().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
  }

  it('the struct the column omits reads as a struct, not as nothing', async () => {
    await renderCollapsed();
    expect(cellAt('Size', 2).textContent).toBe('{…}');
  });

  it('each member of the omitted struct reads its own default', async () => {
    await renderExpanded();
    expect(cellAt('Width', 2).textContent).toBe('0');
    expect(cellAt('Label', 2).textContent).toBe('');
    expect(cellAt('Depth', 2).textContent).toBe('12');
  });
});

describe('RecordPanel — a translated string leaf, whose document spelling is an object, posts its object so the codec receives what it wrote', () => {
  const nameMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'translatedString' });
  const value = { TargetLanguage: 'English', Value: 'Base name' };
  const compare: CompareResult = compareResultFixture({
    conflictAll: 'OnlyOne',
    overrides: [compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: nameMeta, value }], conflictThis: 'OnlyOne' })],
    diffs: [diffNode({ fieldName: 'Name', values: { 'MyMod.esp': value }, winnerColumn: 'MyMod.esp', cellStates: {} })],
  });

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('reads the text and posts set of the whole object with the new Value', async () => {
    renderPanel(compare, { plugins: unionTrackedPluginsResponse });
    await waitFor(() => screen.getByText('Base name'));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.doubleClick(screen.getByText('Base name'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: { TargetLanguage: 'English', Value: 'New name' } },
    }));
  });
});

describe('RecordPanel — a column whose record failed to parse stays in the grid rather than vanishing, showing what was stored and offering nothing that writes; both columns are tracked and mutable, so only the diagnosis can explain a read-only cell', () => {
  const PARSE_DIAGNOSIS = 'the PERK entry point did not have expected parameter type flag';

  const keywordsMeta: FieldMetadata = fieldMeta({
    name: 'Keywords', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'string' }),
  });

  const column = (plugin: string, name: string, parseDiagnosis?: string) => compareOverride({
    formKey: '000001:Broken.esp', plugin,
    isWinner: plugin !== 'Broken.esp', editorId: 'TestNPC',
    fields: [{ metadata: strMeta, value: name }, { metadata: keywordsMeta, value: ['KwdA'] }],
    conflictThis: 'Master', parseDiagnosis,
  });

  const compare: CompareResult = compareResultFixture({
    conflictAll: 'Conflict',
    overrides: [column('Broken.esp', 'Stored Name', PARSE_DIAGNOSIS), column('Good.esp', 'Readable Name')],
    diffs: [
      diffNode({
        fieldName: 'Name', values: { 'Broken.esp': 'Stored Name', 'Good.esp': 'Readable Name' },
        winnerColumn: 'Good.esp', cellStates: {}, conflictAll: 'Conflict',
      }),
      diffNode({
        fieldName: 'Keywords', values: { 'Broken.esp': ['KwdA'], 'Good.esp': ['KwdA'] },
        winnerColumn: 'Good.esp', cellStates: {}, conflictAll: 'NoConflict',
        children: [diffNode({
          fieldName: 'KwdA', values: { 'Broken.esp': 'KwdA', 'Good.esp': 'KwdA' },
          winnerColumn: 'Good.esp', cellStates: {},
        })],
      }),
    ],
  });

  const plugins = [
    { name: 'Broken.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true },
    { name: 'Good.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
  ];

  const contextsFor = (container: HTMLElement, plugin: string) =>
    Array.from(container.querySelectorAll('[data-vscode-context]'))
      .map((e) => parseJsonRecord(e.getAttribute('data-vscode-context') ?? ''))
      .filter(c => c.plugin === plugin);

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Broken.esp'));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column from its stored document rather than dropping it', async () => {
    renderPanel(compare, { plugins });

    await waitFor(() => expect(screen.getByText('Broken.esp')).toBeInTheDocument());
    expect(screen.getByText('Stored Name')).toBeInTheDocument();
  });

  it('opens no editor on its cells, where the readable column opens one', async () => {
    renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    fireEvent.doubleClick(screen.getByText('Stored Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('Readable Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('tells the host the focused cell\'s context when a cell takes the focus, as a field gesture from the palette acts on the focused cell and gets the context its right-click would hand the command', async () => {
    renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Readable Name'));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(screen.getByText('Readable Name'));

    const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
    const toldContexts = (): unknown[] => vi.mocked(vscode.postMessage).mock.calls
      .map(([m]: unknown[]) => m)
      .filter((m): m is { type: string; context: unknown } => isRecord(m) && m.type === WEBVIEW_TO_EXTENSION.FOCUS_CELL)
      .map((m) => m.context);
    await waitFor(() => expect(toldContexts().some((c) =>
      isRecord(c) && c.plugin === 'Good.esp' && String(c.webviewSection).split(' ').includes('stringValue'))).toBe(true));
  });

  it('tells the host a cell was entered on a click, and not when a re-read changes its text, as a background re-read must not take the focus from the list the user is working in (copy value and the name filter act on the focused view)', async () => {
    const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
    const told = (): { context: unknown; entered: unknown }[] => vi.mocked(vscode.postMessage).mock.calls
      .map(([m]: unknown[]) => m)
      .filter((m): m is { type: string; context: unknown; entered: unknown } => isRecord(m) && m.type === WEBVIEW_TO_EXTENSION.FOCUS_CELL);
    let shown = compare;
    const client = panelClient(() => shown, { plugins });
    render(<RecordPanel client={client} />);
    await waitFor(() => screen.getByText('Readable Name'));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(screen.getByText('Readable Name'));
    await waitFor(() => expect(told().some((m) => isRecord(m.context) && m.context.copyText === 'Readable Name')).toBe(true));
    expect(told().filter((m) => m.entered === true)).toHaveLength(1);
    vi.mocked(vscode.postMessage).mockClear();

    shown = {
      ...compare,
      overrides: [compare.overrides[0], column('Good.esp', 'Renamed')].filter((o) => o !== undefined),
      diffs: [
        diffNode({
          fieldName: 'Name', values: { 'Broken.esp': 'Stored Name', 'Good.esp': 'Renamed' },
          winnerColumn: 'Good.esp', cellStates: {}, conflictAll: 'Conflict',
        }),
        ...compare.diffs.slice(1),
      ],
    };
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Broken.esp' },
      }));
    });
    await waitFor(() => expect(told().some((m) => isRecord(m.context) && m.context.copyText === 'Renamed')).toBe(true));
    expect(told().some((m) => m.entered === true)).toBe(false);
  });

  it('tells the host the user entered the grid when the keyboard focuses a cell', async () => {
    const entered = (): unknown[] => vi.mocked(vscode.postMessage).mock.calls
      .map(([m]: unknown[]) => m)
      .filter((m): m is { type: string; entered: unknown } =>
        typeof m === 'object' && m !== null && 'type' in m && m.type === WEBVIEW_TO_EXTENSION.FOCUS_CELL
        && 'entered' in m && m.entered === true);
    renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Readable Name'));
    vi.mocked(vscode.postMessage).mockClear();

    act(() => { screen.getByText('Readable Name').closest('td')?.focus(); });

    await waitFor(() => expect(entered()).toHaveLength(1));
  });

  it('focuses the label cell on a click, and selects no text in the grid', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Readable Name'));
    const label = screen.getAllByText('Name')[0]?.closest('td');
    if (!label) throw new Error('no label cell');

    fireEvent.click(label);

    expect(label).toHaveAttribute('data-focused-cell');
    expect(label).toHaveStyle({ userSelect: 'none' });
    expect(container.querySelectorAll('[data-focused-cell]')).toHaveLength(1);
  });

  it('offers no array right-click commands, where the readable column offers them, the array gestures being host commands gated on the row\'s own data-vscode-context', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const arraySections = (plugin: string) => contextsFor(container, plugin)
      .map(c => String(c.webviewSection)).filter(s => s.includes('array'));
    expect(arraySections('Broken.esp')).toEqual([]);
    expect(arraySections('Good.esp')).not.toEqual([]);
  });

  it('marks the extended editor read-only on its string cells, where the readable column does not, Open in Editor… staying on a read-only column as the only way to read a long value in full', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const stringContext = (plugin: string) => contextsFor(container, plugin)
      .find(c => String(c.webviewSection).includes('stringValue'));
    expect(stringContext('Broken.esp')?.readOnly).toBe(true);
    expect(stringContext('Good.esp')?.readOnly).toBe(false);
  });
});

describe('RecordPanel — the Record Header', () => {
  const nameMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'string' });
  const header = (m: Parameters<typeof fieldMeta>[0]) => fieldMeta({ ...m, isRecordHeaderMember: true });
  const flagsMeta = header({
    name: 'MajorRecordFlagsRaw', type: 'int', displayLabel: 'Record Flags',
    enumMembers: [{ value: 'Deleted', bitValue: '32' }, { value: 'Persistent', bitValue: '1024' }],
  });
  const formKeyMeta = (displayLabel = 'FormID') => header({ name: 'FormKey', type: 'string', displayLabel, isRecordFormKey: true });
  const vciMeta = header({ name: 'VersionControl', type: 'int', displayLabel: 'Version Control Info 1' });
  const native = (formKey: string, editorId: string | null, formIdLabel?: string): CompareResult => compareResultFixture({
    overrides: [
      compareOverride({
        formKey, plugin: 'MyMod.esp', isWinner: true, editorId,
        fields: [
          { metadata: flagsMeta, value: 1024 }, { metadata: formKeyMeta(formIdLabel), value: formKey },
          { metadata: vciMeta, value: 5 }, { metadata: nameMeta, value: 'A Name' },
        ],
      }),
    ],
    diffs: [
      diffNode({ fieldName: 'MajorRecordFlagsRaw', values: { 'MyMod.esp': 1024 }, winnerColumn: 'MyMod.esp' }),
      diffNode({ fieldName: 'FormKey', values: { 'MyMod.esp': formKey }, winnerColumn: 'MyMod.esp' }),
      diffNode({ fieldName: 'VersionControl', values: { 'MyMod.esp': 5 }, winnerColumn: 'MyMod.esp' }),
      diffNode({ fieldName: 'Name', values: { 'MyMod.esp': 'A Name' }, winnerColumn: 'MyMod.esp' }),
    ],
  });
  const pluginHeaderFormId = header({
    name: 'FormID', type: 'int', displayLabel: 'FormID', readOnlyReason: 'names the plugin itself', isRecordFormKey: true,
  });
  const pluginHeader = (): CompareResult => compareResultFixture({
    overrides: [
      compareOverride({
        formKey: '000000:MyMod.esp', plugin: 'MyMod.esp', isWinner: true, editorId: null,
        fields: [{ metadata: pluginHeaderFormId, value: null }, { metadata: nameMeta, value: 'A Name' }],
      }),
    ],
    diffs: [
      diffNode({ fieldName: 'FormID', values: { 'MyMod.esp': null } }),
      diffNode({ fieldName: 'Name', values: { 'MyMod.esp': 'A Name' }, winnerColumn: 'MyMod.esp' }),
    ],
  });
  const tracked = [{ name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true }];

  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll('tbody tr'));
  const rowLabels = (container: HTMLElement) =>
    rows(container).map(tr => tr.querySelector('td')?.textContent.replace(/^[▶▼]/, ''));
  const cellOf = (container: HTMLElement, label: string) =>
    required(rows(container).find(tr => tr.querySelector('td')?.textContent.replace(/^[▶▼]/, '') === label)?.querySelectorAll('td')[1],
      `the ${label} cell`);
  const formIdCell = (container: HTMLElement) => cellOf(container, 'FormID');

  afterEach(() => vi.unstubAllGlobals());

  it('is the grid\'s first row, holding the header members mEdit names, in its order and under its labels', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    expect(rowLabels(container)).toEqual(['Record Header', 'Record Flags', 'FormID', 'Version Control Info 1', 'Name']);
    expect(formIdCell(container).textContent).toBe('MovedNpc [000800:MyMod.esp]');
  });

  it('reads the FormKey in the row the metadata marks as the record\'s FormKey, under the label it gives', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc', 'Form Key'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    expect(cellOf(container, 'Form Key').textContent).toBe('MovedNpc [000800:MyMod.esp]');
  });

  it('collapses to its own row, hiding the header members', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    fireEvent.doubleClick(screen.getByText('Record Header'));

    expect(rowLabels(container)).toEqual(['Record Header', 'Name']);
  });

  it('edits a header member as any field: a typed number posts a set of that member', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));
    vi.mocked(vscode.postMessage).mockClear();

    const cell = cellOf(container, 'Version Control Info 1');
    fireEvent.doubleClick(within(cell).getByText('5'));
    const input = required(cell.querySelector('input'), 'the cell\'s input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('VersionControl')], value: 7 });
  });

  it('reads Record Flags as its flags, and a check box posts the integer with that bit set', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));
    vi.mocked(vscode.postMessage).mockClear();

    const boxes = within(cellOf(container, 'Record Flags')).getAllByRole('checkbox');
    expect(boxes.map(b => b.matches(':checked'))).toEqual([false, true]);
    fireEvent.click(required(boxes[0], 'the Deleted check box'));

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('MajorRecordFlagsRaw')], value: 1024 | 32 });
  });

  it('opens the FormID on the FormKey and posts a set of the record\'s FormKey member with the one typed', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));
    vi.mocked(vscode.postMessage).mockClear();

    const cell = formIdCell(container);
    fireEvent.doubleClick(within(cell).getByText('MovedNpc [000800:MyMod.esp]'));
    const input = required(cell.querySelector('input'), "the FormID cell's input");
    expect(input).toHaveValue('000800:MyMod.esp');
    fireEvent.change(input, { target: { value: '000900:MyMod.esp' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({
      op: 'set', path: [member('FormKey')], value: '000900:MyMod.esp',
    });
  });

  it('reads a plugin header\'s FormID as its FormKey, opening no editor and giving the reason', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { container } = renderPanel(pluginHeader(), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    expect(rowLabels(container)).toEqual(['Record Header', 'FormID', 'Name']);
    fireEvent.doubleClick(within(formIdCell(container)).getByText('000000:MyMod.esp'));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(formIdCell(container)).toHaveAttribute('title', expect.stringContaining('names the plugin itself'));
  });

  it('opens the editor on a record\'s FormID', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { container } = renderPanel(native('000000:MyMod.esp', null), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    fireEvent.doubleClick(within(formIdCell(container)).getByText('000000:MyMod.esp'));

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  const stampMeta = header({ name: 'VersionControl', type: 'int', displayLabel: 'Version Control Info 1', isVersionControlInfo1: true });
  const formVersionMeta = header({ name: 'FormVersion', type: 'int', displayLabel: 'Form Version' });
  const stamped = (copies: { plugin: string; stamp: number | null; formVersion: number | null }[]): CompareResult =>
    compareResultFixture({
      overrides: copies.map(({ plugin, stamp, formVersion }) => compareOverride({
        formKey: '000800:Base.esm', plugin, isWinner: plugin === copies.at(-1)?.plugin, editorId: 'Stamped',
        fields: [
          { metadata: stampMeta, value: stamp }, { metadata: formVersionMeta, value: formVersion },
          { metadata: nameMeta, value: 'A Name' },
        ],
      })),
      diffs: [
        diffNode({ fieldName: 'VersionControl', values: Object.fromEntries(copies.map(c => [c.plugin, c.stamp])) }),
        diffNode({ fieldName: 'FormVersion', values: Object.fromEntries(copies.map(c => [c.plugin, c.formVersion])) }),
        diffNode({ fieldName: 'Name', values: Object.fromEntries(copies.map(c => [c.plugin, 'A Name'])) }),
      ],
    });
  const stampPlugins = [
    { name: 'Base.esm', isImmutable: false, loadOrderIndex: 0, isTracked: true },
    { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
  ];
  const stampCells = (container: HTMLElement) =>
    Array.from(required(rows(container).find(tr => tr.querySelector('td')?.textContent === 'Version Control Info 1'),
      'the Version Control Info 1 row').querySelectorAll('td')).slice(1);

  it('reads Version Control Info 1 as the date, user and index it packs, by each copy\'s own Form Version', async () => {
    vi.stubGlobal('mEditFormKey', '000800:Base.esm');
    const { container } = renderPanel(stamped([
      { plugin: 'Base.esm', stamp: 33890154, formVersion: 43 },
      { plugin: 'MyMod.esp', stamp: 33890154, formVersion: 44 },
    ]), { plugins: stampPlugins });
    await waitFor(() => screen.getAllByText('A Name'));

    expect(stampCells(container).map(c => c.textContent)).toEqual([
      '2005-07-106 User: 5 Index: 2', '2015-11-10 User: 5 Index: 2',
    ]);
  });

  it('reads Version Control Info 1 as None where it packs nothing, and by the older packing where the copy holds no Form Version', async () => {
    vi.stubGlobal('mEditFormKey', '000800:Base.esm');
    const { container } = renderPanel(stamped([
      { plugin: 'Base.esm', stamp: null, formVersion: 131 },
      { plugin: 'MyMod.esp', stamp: 17001482, formVersion: null },
    ]), { plugins: stampPlugins });
    await waitFor(() => screen.getAllByText('A Name'));

    expect(stampCells(container).map(c => c.textContent)).toEqual(['None', '2011-12-10 User: 3 Index: 1']);
  });

  it('reads a Version Control Info 1 held signed, as a plugin header holds it, as the 32 bits it packs', async () => {
    vi.stubGlobal('mEditFormKey', '000800:Base.esm');
    const { container } = renderPanel(stamped([{ plugin: 'MyMod.esp', stamp: -1, formVersion: 131 }]), { plugins: stampPlugins });
    await waitFor(() => screen.getAllByText('A Name'));

    expect(stampCells(container).map(c => c.textContent)).toEqual(['2127-15-31 User: 255 Index: 255']);
  });

  it('opens and copies Version Control Info 1 as the number it holds', async () => {
    vi.stubGlobal('mEditFormKey', '000800:Base.esm');
    const { container } = renderPanel(stamped([{ plugin: 'MyMod.esp', stamp: 33890154, formVersion: 131 }]), { plugins: stampPlugins });
    await waitFor(() => screen.getAllByText('A Name'));
    const cell = required(stampCells(container)[0], 'the Version Control Info 1 cell');

    expect(parseJsonRecord(required(cell.getAttribute('data-vscode-context'), 'its context')).copyText).toBe('33890154');
    fireEvent.doubleClick(within(cell).getByText('2015-11-10 User: 5 Index: 2'));
    expect(required(cell.querySelector('input'), 'the cell\'s input')).toHaveValue(33890154);
  });

  const partialFormCopyWithHeaderMembersAndNoFieldsOfItsOwn = (): CompareResult => {
    const record = native('000800:MyMod.esp', 'Inside');
    return {
      ...record,
      overrides: record.overrides.map(o => ({ ...o, isPartialForm: true })),
      diffs: record.diffs.map(d => d.fieldName === 'Name' ? { ...d, values: { 'MyMod.esp': null } } : d),
    };
  };

  it('edits a Partial Form copy\'s header member', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(partialFormCopyWithHeaderMembersAndNoFieldsOfItsOwn(), { plugins: tracked });
    await waitFor(() => screen.getByText('(Partial Form)'));
    vi.mocked(vscode.postMessage).mockClear();

    const cell = cellOf(container, 'Version Control Info 1');
    fireEvent.doubleClick(within(cell).getByText('5'));
    const input = required(cell.querySelector('input'), 'the cell\'s input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('VersionControl')], value: 7 });
  });

  it('edits a Partial Form copy\'s EditorID, which the copy keeps', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const editorIdMeta = fieldMeta({ name: 'EditorID', type: 'string', allowsNull: true, isEditorId: true });
    const record = partialFormCopyWithHeaderMembersAndNoFieldsOfItsOwn();
    const { container } = renderPanel({
      ...record,
      overrides: record.overrides.map(o => ({ ...o, fields: [{ metadata: editorIdMeta, value: 'Inside' }, ...o.fields] })),
      diffs: [diffNode({ fieldName: 'EditorID', values: { 'MyMod.esp': 'Inside' }, winnerColumn: 'MyMod.esp' }), ...record.diffs],
    }, { plugins: tracked });
    await waitFor(() => screen.getByText('(Partial Form)'));
    vi.mocked(vscode.postMessage).mockClear();

    const cell = cellOf(container, 'EditorID');
    fireEvent.doubleClick(within(cell).getByText('Inside'));
    const input = required(cell.querySelector('input'), 'the cell\'s input');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastPostedEnvelope(vscode.postMessage)).toEqual({ op: 'set', path: [member('EditorID')], value: 'Renamed' });
  });

  it('reads a Partial Form copy\'s own field empty, opening no editor', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(partialFormCopyWithHeaderMembersAndNoFieldsOfItsOwn(), { plugins: tracked });
    await waitFor(() => screen.getByText('(Partial Form)'));

    const cell = cellOf(container, 'Name');
    fireEvent.doubleClick(cell);

    expect(cell.textContent).toBe('');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers the FormID no open-field-value menu, where a text field offers one, open field value being a text field\'s and the FormID reading as a reference', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    const menuOf = (cell: Element) => cell.closest('[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '';
    expect(menuOf(formIdCell(container))).not.toContain('stringValue');
    expect(menuOf(required(screen.getByText('A Name').closest('td'), "Name's cell"))).toContain('stringValue');
  });
});

describe('RecordPanel — a field the schema marks read-only, the reason coming from the field\'s own metadata with nothing in the panel deciding it', () => {
  const reason = 'a known upstream defect';
  const tracked = [{ name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true }];
  const lockedName = fieldMeta({ name: 'Name', type: 'string', readOnlyReason: reason });
  const compare = compareResultFixture({
    overrides: [
      compareOverride({
        formKey: '000800:MyMod.esp', plugin: 'MyMod.esp', isWinner: true, editorId: 'Npc',
        fields: [{ metadata: lockedName, value: 'A Name' }],
      }),
    ],
    diffs: [diffNode({ fieldName: 'Name', values: { 'MyMod.esp': 'A Name' }, winnerColumn: 'MyMod.esp' })],
  });

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000800:MyMod.esp'));
  afterEach(() => vi.unstubAllGlobals());

  it('opens no editor and gives the reason as the cell\'s tooltip', async () => {
    renderPanel(compare, { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    fireEvent.doubleClick(screen.getByText('A Name'));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(required(screen.getByText('A Name').closest('td'), 'the cell')).toHaveAttribute('title', expect.stringContaining(reason));
  });

  it('gives a field with no reason only its state as the tooltip', async () => {
    const open = fieldMeta({ name: 'Name', type: 'string' });
    renderPanel({
      ...compare,
      overrides: [compareOverride({
        formKey: '000800:MyMod.esp', plugin: 'MyMod.esp', isWinner: true, editorId: 'Npc',
        fields: [{ metadata: open, value: 'A Name' }],
      })],
    }, { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    expect(required(screen.getByText('A Name').closest('td'), 'the cell')).toHaveAttribute('title', 'Single Record');
  });
});

describe('RecordPanel — several records side by side', () => {
  const [GUN, AMMO] = ['000801:A.esp', '000802:A.esp'];
  const sideBySide: CompareResult = compareResultFixture({
    overrides: [
      compareOverride({ formKey: GUN, plugin: 'A.esp', isWinner: true, editorId: 'Gun', fields: [{ metadata: strMeta, value: 'Gun Name' }], conflictThis: null, column: '0#A.esp' }),
      compareOverride({ formKey: AMMO, plugin: 'A.esp', isWinner: true, editorId: 'Ammo', fields: [{ metadata: strMeta, value: 'Ammo Name' }], conflictThis: null, column: '1#A.esp' }),
    ],
    diffs: [diffNode({ fieldName: 'Name', values: { '0#A.esp': 'Gun Name', '1#A.esp': 'Ammo Name' }, winnerColumn: '1#A.esp' })],
  });
  const tracked = [{ name: 'A.esp', isTracked: true }];

  beforeEach(() => { vi.stubGlobal('mEditFormKey', GUN); });
  afterEach(() => vi.unstubAllGlobals());

  it('shows one column for each record, in the order given, though two come from one plugin, each with its plugin\'s status', async () => {
    renderPanel(sideBySide, { plugins: tracked });

    await waitFor(() => expect(screen.getByText('Ammo Name')).toBeInTheDocument());
    const nameCells = Array.from(required(screen.getByText('Gun Name').closest('tr'), 'the Name row').querySelectorAll('td')).slice(1);
    expect(nameCells.map(cell => cell.textContent)).toEqual(['Gun Name', 'Ammo Name']);
    expect(screen.getAllByText('(tracked)')).toHaveLength(2);
  });

  it('opens another record\'s copy in this tab on a click on its header, with the same records as its columns, that one first as the file', async () => {
    const KNIFE = '000803:B.esp';
    const threeRecords = structuredClone(sideBySide);
    threeRecords.overrides.push(compareOverride({
      formKey: KNIFE, plugin: 'B.esp', origin: 'ModB', isWinner: true, editorId: 'Knife', fields: [{ metadata: strMeta, value: 'Knife Name' }], conflictThis: null, column: '2#B.esp|ModB',
    }));
    required(threeRecords.diffs[0], 'the Name row').values['2#B.esp|ModB'] = 'Knife Name';
    renderPanel(threeRecords, { plugins: tracked, fileColumn: '0#A.esp' });
    await waitFor(() => expect(screen.getByText('Knife Name')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(required(screen.getByText('B.esp').closest('th'), 'the Knife column\'s header'));

    const A = { name: 'A.esp', origin: 'Data/' };
    expect(vi.mocked(vscode.postMessage).mock.calls.filter(([m]) => m.type === WEBVIEW_TO_EXTENSION.OPEN_COLUMNS)).toEqual([[{
      type: WEBVIEW_TO_EXTENSION.OPEN_COLUMNS,
      records: [{ formKey: KNIFE, plugin: { name: 'B.esp', origin: 'ModB' } }, { formKey: GUN, plugin: A }, { formKey: AMMO, plugin: A }],
    }]]);
  });

  it('names the first record, the file\'s, in its header, though another record\'s copy is a winner', async () => {
    const firstLoses = structuredClone(sideBySide);
    required(firstLoses.overrides[0], 'the first copy').isWinner = false;
    renderPanel(firstLoses, { plugins: tracked });

    await waitFor(() => expect(screen.getByText('Non-Player Character Gun [000801:A.esp]')).toBeInTheDocument());
  });

  it('files a string field\'s own tab under its column\'s record', async () => {
    renderPanel(sideBySide, { plugins: tracked });
    await waitFor(() => expect(screen.getByText('Ammo Name')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Ammo Name'));

    expect(lastToldCell(vscode.postMessage)).toMatchObject({ formKey: AMMO, recordLabel: 'Ammo [000802:A.esp]' });
  });

  it('says nothing of an incomplete comparison: the colours compare copies of one record', async () => {
    renderPanel(sideBySide, { plugins: tracked, conflictsComputed: false });

    await waitFor(() => expect(screen.getByText('Ammo Name')).toBeInTheDocument());
    expect(screen.queryByText(required(recordPanelIncompleteMessage(false), 'the message'))).not.toBeInTheDocument();
  });

  it('edits in the first record\'s column alone, the file\'s, though another record\'s copy is in the same tracked plugin', async () => {
    renderPanel(sideBySide, { plugins: tracked, fileColumn: '0#A.esp' });
    await waitFor(() => expect(screen.getByText('Ammo Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Ammo Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('Gun Name'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD, formKey: GUN, plugin: 'A.esp',
    }));
  });

  it('reads at once with the records the host shows beside its own from now on', async () => {
    const { client } = renderPanel(sideBySide, { plugins: tracked });
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(1));
    const columns = [{ formKey: AMMO, plugin: { name: 'A.esp', origin: 'Data/' } }];

    sendMessage({ type: EXTENSION_TO_WEBVIEW.SHOW_COLUMNS, columns });

    expect(client.showColumns).toHaveBeenCalledWith(columns);
    await waitFor(() => expect(client.load).toHaveBeenCalledTimes(2));
  });
});

describe('RecordPanel — a string field\'s own tab, opened from one record\'s column', () => {
  beforeEach(() => { vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'); });
  afterEach(() => vi.unstubAllGlobals());

  it('is filed under the record as the panel names it, by the winning copy\'s EditorID, from any column', async () => {
    const renamed = structuredClone(compareResult);
    required(renamed.overrides[0], 'the master copy').editorId = 'OldNPC';
    renderPanel(renamed);
    await waitFor(() => expect(screen.getByText('Original Name')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Original Name'));

    expect(lastToldCell(vscode.postMessage)).toMatchObject({ plugin: 'Fallout4.esm', recordLabel: 'TestNPC [000001:Fallout4.esm]' });
  });
});
