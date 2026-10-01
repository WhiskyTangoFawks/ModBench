import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import { recordPanelIncompleteMessage } from './recordPanelIncompleteMessage';
import { DIMMED_OPACITY } from './gridStyles';
import type { FieldMetadata } from './types';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastPostedEnvelope, member, panelClient,
  parseJsonRecord, required,
  type PanelOpts,
} from './test/fixtures';
import type { CompareResult } from './types';

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
      // ADR-0005: the backend carries a resolution signal per FormKey value; an unresolved
      // default would exercise no affordance at all.
      resolutions: { 'Fallout4.esm': { state: 'ResolvedValidType', recordType: 'race', editorId: 'HumanRace' } },
    }),
  ],
});

const overrideCompareResult: CompareResult = compareResultFixture({
  conflictAll: 'Override',
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

// The Partial Form toggle is disabled on an untracked column, so the dispatch needs a tracked
// one.
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
      isPartialForm: true, isPartialFormable: true,
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

// The document names both A and B, so the resting label reads "A, B".
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

// MyMod.esp must be tracked for editableColumns to include it at all, so the real gate runs
// rather than a hand-fed set.
const flagsTrackedPluginsResponse = [
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

// `pluginsResponse` is this file's own default column set; every other option is the shared
// fixture's.
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

  it('shows the record title with editorId and formKey after loading', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText(/TestNPC \[000001:Fallout4\.esm\]/, { selector: 'div' })).toBeInTheDocument());
  });

  it('shows field names from the diff table', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
  });

  // Master leftmost, winner rightmost, as in xEdit.
  it('shows each override\'s own field value in its own column', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  // There is no edit mode. Editing affordances follow the column's plugin
  // mutability, not a mode the user has to enter on every record navigation.
  it('renders no Edit/View mode toggle', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  // ADR-0007: writing the binary is the separate compile gesture, scoped to a whole
  // plugin, never a per-plugin control on this panel.
  it('offers no per-plugin Save — writing the binary is compile, not this panel', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  // ADR-0018: a cell in an immutable column opens no input at all, however it is clicked —
  // nothing ever reaches a write from here.
  it('a cell in an immutable column opens nothing when clicked', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

});


// ADR-0012: two columns sharing a filename but differing in origin — display never changes, so
// only the compound (plugin, origin) identity can tell them apart.

describe('RecordPanel — a column header', () => {
  afterEach(() => vi.unstubAllGlobals());

  // ADR-0012 invariant 3: origin is never what the user reads.
  it('does not render origin inline', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    expect(screen.queryByText(/MyMod\.esp \(/)).not.toBeInTheDocument();
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

    // The context lives on PluginHeader's own root div, nested inside RecordPanel's <th>.
    const headerRoot = container.querySelector('th > div');
    if (!headerRoot) throw new Error('expected a PluginHeader root under the recordHeader th');
    const headerContext = headerRoot.getAttribute('data-vscode-context');
    if (!headerContext) throw new Error('expected the PluginHeader root to carry a data-vscode-context attribute');
    expect(JSON.parse(headerContext)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      compilable: false, preventDefaultContextMenuItems: true,
    });
  });

  // editor.md, Menus and keys: compile on a tracked column, not on an untracked or a read-only one.
  // Track and decompile read the column's origin against the mods' repositories, in the manifest.
  it.each([
    ['a tracked, editable', { isTracked: true, isImmutable: false }, true],
    ['an untracked', { isTracked: false, isImmutable: false }, false],
    ['a read-only', { isTracked: true, isImmutable: true }, false],
    ['an untracked read-only', { isTracked: false, isImmutable: true }, false],
  ])('the header of %s plugin says whether compile applies to it', async (_what, facts, compilable) => {
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
      const headerContext = container.querySelector('th > div')?.getAttribute('data-vscode-context') ?? '{}';
      expect(parseJsonRecord(headerContext).compilable).toBe(compilable);
    });
  });

  // commands.md, No dead entries: when /plugins fails, a column is neither tracked nor untracked.
  it('offers no compile on a column whose tracked state is unknown', async () => {
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
      ok: true, result: compare, immutableSet: null, trackedSet: null, conflictsComputed: true,
    });
    const { container } = renderPanel(compare, { load });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const headerContext = container.querySelector('th > div')?.getAttribute('data-vscode-context') ?? '{}';
    expect(parseJsonRecord(headerContext).compilable).toBe(false);
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

  it('renders the column header dimmed, matching xEdit-style marking rather than a full competing override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const th = screen.getByText('MyMod.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  // One dimmed set reaches the header and every cell under it: a header-only rule would leave the
  // column's own cells at full weight once the non-sticky header scrolls away.
  it('renders every cell of that column dimmed too', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());

    const nameRow = screen.getByText('Name').closest('tr');
    if (!nameRow) throw new Error('expected a tr ancestor of the Name row');
    const cells = nameRow.querySelectorAll('td');
    expect(cells[2]).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    expect(cells[1]).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  // The panel resolves every row's schema leaf itself, so a diff naming a member no override
  // declares has no shape to render against and neither it nor its subtree appears.
  it('drops a diff node naming a member no override\'s schema declares', async () => {
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

describe('RecordPanel — Partial Form header toggle', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  // The flag is the annotated synthetic member `IsPartialForm`, written through the one envelope.
  it('unchecking the checkbox posts set of IsPartialForm to false', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(screen.getByRole('checkbox'));

    // origin deliberately unasserted: this fixture's MyMod.esp override omits it.
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'IsPartialForm' }], value: false },
    }));
  });
});

// Drives the gesture through the real editableColumns computation rather than a hand-fed set,
// with a scalar cell and a flags cell on the identical column so only the field type differs.
describe('RecordPanel — flags cell editing through real message plumbing', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  // The control: a scalar edit on the identical tracked, editable column the flags cases use.
  it('control: a scalar cell in a tracked, editable column opens an editable input on double click', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Override Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // A flags row opens expanded, its checkbox list enabled only in the tracked, editable column;
  // the arrow beside the label collapses it to the compact summary.
  it('a flags row opens expanded with enabled checkboxes; collapsing shows the summary and expanding restores them', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0));
    // The immutable master column's checkboxes are disabled.
    const enabled = () => screen.getAllByRole('checkbox').filter((b): b is HTMLInputElement => b instanceof HTMLInputElement && !b.disabled);
    expect(enabled()).toHaveLength(2);
    const flagsRow = () => required(screen.getByText('Flags').closest('tr'), "the Flags row");

    fireEvent.click(within(flagsRow()).getByRole('button', { name: '▼' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('A, B')).toHaveLength(2);

    fireEvent.click(within(flagsRow()).getByRole('button', { name: '▶' }));
    expect(enabled()).toHaveLength(2);
  });

  it('toggling a flag posts set of the member with the names now set', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0));
    vi.mocked(vscode.postMessage).mockClear();

    // uncheck A in the tracked column — the first *enabled* box, since the master column's
    // disabled checkboxes render first in column order.
    const [firstEnabledCheckbox] = screen.getAllByRole('checkbox').filter((b): b is HTMLInputElement => b instanceof HTMLInputElement && !b.disabled);
    if (!firstEnabledCheckbox) throw new Error('expected an enabled checkbox in the tracked column');
    fireEvent.click(firstEnabledCheckbox);

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

  // Each field's own diffs[].conflictAll drives its own row, never the record-wide
  // CompareResult.conflictAll smeared onto every row.
  it('applies green row background to a field whose own conflictAll is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr');
    if (!row) throw new Error('expected a tr ancestor of the Name row');
    expect(row.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('applies orange row background to a field whose own conflictAll is Conflict', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr');
    if (!row) throw new Error('expected a tr ancestor of the Name row');
    expect(row.style.backgroundColor).toBe('rgba(255, 152, 0, 0.20)');
  });

  // Two sibling fields, only one differing: a record-wide smear would tint both rows alike.
  it('colors only the field that actually differs — an agreeing sibling row gets no background', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(twoSiblingFieldsResult);
    await waitFor(() => screen.getByText('Name'));
    const nameRow = screen.getByText('Name').closest('tr');
    const levelRow = screen.getByText('Level').closest('tr');
    if (!nameRow) throw new Error('expected a tr ancestor of the Name row');
    if (!levelRow) throw new Error('expected a tr ancestor of the Level row');
    expect(nameRow.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
    expect(levelRow.style.backgroundColor).toBe('');
  });

  it('applies orange cell background when cellStates is ConflictWins', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td');
    if (!cell) throw new Error('expected a td ancestor of the Override Name cell');
    expect(cell.style.backgroundColor).toBe('rgba(255, 152, 0, 0.18)');
  });

  it('applies green cell background when cellStates is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td');
    if (!cell) throw new Error('expected a td ancestor of the Override Name cell');
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });

  it('column header background reflects CompareOverride.conflictThis', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    // MyMod.esp header: conflictThis = 'ConflictWins' → orange background in the <th>
    const header = screen.getByText('MyMod.esp').closest('th');
    if (!header) throw new Error('expected a th ancestor of the MyMod.esp header cell');
    expect(header.style.backgroundColor).toBe('rgba(255, 152, 0, 0.35)');
  });
});

describe('RecordPanel — postMessage wiring', () => {
  const fkPlugins = [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }];

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('calls vscode.postMessage with type openRecord when a FormKey link is Ctrl+clicked', async () => {
    renderPanel(fkCompareResult, { plugins: fkPlugins });
    // Labelled with the "EditorID [FormKey]" composite, so the reference is identifiable from
    // the cell alone rather than only by its EditorID.
    await waitFor(() => screen.getByText('HumanRace [00013918:Fallout4.esm]'));
    fireEvent.click(screen.getByText('HumanRace [00013918:Fallout4.esm]'), { ctrlKey: true });
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.OPEN_RECORD,
      formKey: '00013918:Fallout4.esm',
    });
  });

  it('re-loads with the new formKey when a loadRecord message arrives from the extension', async () => {
    const { client } = renderPanel(fkCompareResult, { plugins: fkPlugins });
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]', { selector: 'div' }));

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

  it('double clicking the label collapses an expanded row and expands it again', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('X'));

    fireEvent.doubleClick(screen.getByText('Bounds'));
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText('Bounds'));
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  // The master's X: 10 beside the override's X: 15 — the delta struct expansion exists to show.
  it('child row for X shows each override\'s own sub-field value', async () => {
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
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });
});

describe('RecordPanel — keys through the rows (editor.md, The focused cell, story 4)', () => {
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
    const { container } = await focusedOn('Name', { plugins: flagsTrackedPluginsResponse }, flagsCompareResult);
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

describe('RecordPanel — incomplete-comparison banner (ADR-0013)', () => {
  // conflictsComputed: false always returns the banner text (recordPanelIncompleteMessage.ts) —
  // bounded so every test below can rely on it being present.
  const incompleteMessage = recordPanelIncompleteMessage(false);
  if (!incompleteMessage) throw new Error('expected a banner message when conflicts are not yet computed');

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('states the comparison is incomplete when opened while the winner sweep is outstanding (AC1)', async () => {
    renderPanel(compareResult, { conflictsComputed: false });
    await waitFor(() => screen.getByText(incompleteMessage));
  });

  it('shows no statement once the sweep has already completed (AC3)', async () => {
    renderPanel(compareResult, { conflictsComputed: true });
    await waitFor(() => screen.getByText(/TestNPC/, { selector: 'div' }));
    expect(screen.queryByText(incompleteMessage)).not.toBeInTheDocument();
  });

  // A panel already open when the sweep lands must reflect the settled data, not just clear its
  // banner over stale content.
  it('refetches and reflects settled data when CONFLICTS_COMPUTED arrives (AC4)', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(), conflictsComputed: false,
      })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(), conflictsComputed: true,
      });
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText(incompleteMessage));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED } }));
    });

    await waitFor(() => expect(screen.queryByText(incompleteMessage)).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A panel this message reaches before it has loaded any record must not throw or fetch.
  it('does nothing when CONFLICTS_COMPUTED arrives before any record is loaded', () => {
    vi.stubGlobal('mEditFormKey', '');
    const load = vi.fn();
    renderPanel(compareResult, { load });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED } }));
    });

    expect(load).not.toHaveBeenCalled();
  });
});

describe('RecordPanel — LOAD_RECORD state management', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

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
    // First load fails; the LOAD_RECORD-driven reload succeeds.
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(['Fallout4.esm']), conflictsComputed: true,
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
});

const loaded = (result: CompareResult | null, conflictsComputed = true) => ({
  ok: true as const, result, immutableSet: new Set<string>(), trackedSet: new Set<string>(), conflictsComputed,
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

describe('RecordPanel — states (editor.md, States)', () => {
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

describe('RecordPanel — column collapse (issue #3)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('clicking a plugin column header chip collapses that column, hiding its field values', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    // the chip itself stays visible
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
  });

  it('clicking a collapsed column chip again expands it', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('collapsed column header hides the (read-only) label', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('(read-only)'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
  });

  it('collapsed state survives a LOAD_RECORD navigation to a different formKey', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => screen.getByText('MyMod.esp'));
    // Still collapsed after navigating to a new record in the same panel load order.
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
  });
});

// Two plugins can disagree on which leaf of an abstract union an element is, so the element's
// rows are both leaves' members. A member's `variants`, read through the element's discriminator,
// name the leaves declaring it.
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

// Both plugins carry the same leaf, and the backend drops a member null in every column, so
// only that leaf's members remain.
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

describe('RecordPanel — union element rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Scoped to the grid's own body — the column headers carry their own load-order index, so
  // "[0]" is not unique document-wide.
  const rows = () => within(required(screen.getByRole('table').querySelector('tbody'), "the table's tbody"));

  function labelCell(label: string): HTMLElement {
    return required(rows().getByText(label).closest('td'), `the '${label}' cell's td ancestor`);
  }

  async function renderElement() {
    renderPanel(mixedLeafAliasResult);
    await waitFor(() => rows().getByText('aliases'));
    await waitFor(() => rows().getByText('[0]'));
    await waitFor(() => rows().getByText('location'));
  }

  it('shows the union of both plugins\' leaf members', async () => {
    await renderElement();
    expect(rows().getByText('name')).toBeInTheDocument();
    expect(rows().getByText('location')).toBeInTheDocument();
    expect(rows().getByText('external')).toBeInTheDocument();
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

  // An element's rows are the ones its own plugins carry, never one per schema member: the
  // other leaves' members are null in every column and never reach the webview.
  it('shows no row for a member no plugin\'s leaf declares', async () => {
    renderPanel(singleLeafAliasResult);
    await waitFor(() => rows().getByText('aliases'));
    await waitFor(() => rows().getByText('[0]'));
    await waitFor(() => rows().getByText('location'));
    expect(rows().queryByText('external')).not.toBeInTheDocument();
  });

  it('indents each nesting level by its own depth', async () => {
    await renderElement();
    expect(labelCell('aliases')).not.toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('[0]')).toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('location')).toHaveStyle({ paddingLeft: '48px' });

    for (const aliasId of rows().getAllByText('alias_id')) {
      expect(aliasId.closest('td')).toHaveStyle({ paddingLeft: '72px' });
    }
  });
});

// A Mutagen class name is a wire token the user is never shown, so the panel displays the
// reflector's labels and posts the values.
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

describe('RecordPanel — an abstract union\'s leaf is an editable field', () => {
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

  // A discriminator switch is the Kind row's own set; the backend switches the leaf.
  it('posts set of the discriminator member carrying the chosen leaf\'s own wire value, not its label', async () => {
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

// Absent means default (ADR-0005): the document omits a member equal to its default, and the grid
// reads it back as that default. "—" is kept for a member whose metadata says null is a value.
describe('RecordPanel — an absent member reads as its default', () => {
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

  const rows = () => within(required(screen.getByRole('table').querySelector('tbody'), "the table's tbody"));
  const cellsOf = (label: string) => required(rows().getByText(label).closest('tr'), `the '${label}' row`).querySelectorAll('td');
  const cellAt = (label: string, index: number) => required(cellsOf(label)[index], `the '${label}' row's cell ${index}`);

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderExpanded() {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Stats'));
    await waitFor(() => rows().getByText('Weight'));
  }

  it('an absent int reads 0, an absent bool false, an absent string empty', async () => {
    await renderExpanded();
    expect(cellAt('Weight', 2).textContent).toBe('0');
    expect(cellAt('Essential', 2).textContent).toBe('False');
    expect(cellAt('Prefix', 2).textContent).toBe('');
    expect(rows().queryAllByText('—')).toHaveLength(1);
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

  // The default is what the editor opens on, so a value equal to it is no edit at all.
  it('editing an absent int from its default posts one set with the typed value', async () => {
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

// A member whose owner is not there in a column is not absent-by-default: there is nothing for it
// to be a member of, so it reads as nothing, not as zero.
describe('RecordPanel — a member of an absent owner reads as nothing', () => {
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

  const rows = () => within(required(screen.getByRole('table').querySelector('tbody'), "the table's tbody"));
  const cellsOf = (label: string) => required(rows().getByText(label).closest('tr'), `the '${label}' row`).querySelectorAll('td');
  const cellAt = (label: string, index: number) => required(cellsOf(label)[index], `the '${label}' row's cell ${index}`);

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('an unset nullable struct reads as empty, and its member as nothing rather than zero', async () => {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Bounds'));
    expect(cellAt('Bounds', 2).textContent).toBe('');
    await waitFor(() => rows().getByText('X'));

    expect(cellAt('X', 1).textContent).toBe('10');
    expect(cellAt('X', 2).textContent).toBe('');
  });

  it('an element past the column\'s own length reads as nothing, not zero', async () => {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Values'));
    await waitFor(() => rows().getByText('[1]'));

    expect(cellAt('[1]', 1).textContent).toBe('2');
    expect(cellAt('[1]', 2).textContent).toBe('');
  });

  // The classifier nulls every field of a Partial Form column: none of them is absent-by-default.
  it('a Partial Form column\'s fields read as nothing', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Name'));
    expect(cellAt('Name', 1).textContent).toBe('Original Name');
    expect(cellAt('Name', 2).textContent).toBe('');
  });

  // A non-nullable struct is the field whose absence would otherwise read as its default.
  it('a Partial Form column\'s non-nullable struct field reads as nothing, not as its default', async () => {
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
    await waitFor(() => rows().getByText('Size'));
    fireEvent.click(required(required(rows().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
    expect(cellAt('Size', 1).textContent).toBe('{…}');
    expect(cellAt('Size', 2).textContent).toBe('');

    fireEvent.click(required(required(rows().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
    await waitFor(() => rows().getByText('Width'));
    expect(cellAt('Width', 2).textContent).toBe('');
  });
});

// ADR-0005: absent means default. A non-nullable struct has no "unset", so the column that omits
// it holds that struct at its defaults, member by member.
describe('RecordPanel — an absent non-nullable struct reads as its default members', () => {
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

  const rows = () => within(required(screen.getByRole('table').querySelector('tbody'), "the table's tbody"));
  const cellsOf = (label: string) => required(rows().getByText(label).closest('tr'), `the '${label}' row`).querySelectorAll('td');
  const cellAt = (label: string, index: number) => required(cellsOf(label)[index], `the '${label}' row's cell ${index}`);

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderExpanded() {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Width'));
  }

  async function renderCollapsed() {
    await renderExpanded();
    fireEvent.click(required(required(rows().getByText('Size').closest('td'), "the 'Size' cell's td ancestor").querySelector('button'), "the 'Size' row's expand button"));
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

// A translated string is one leaf whose document spelling is an object; its set carries that
// object, so the codec receives what it wrote.
describe('RecordPanel — a translated string leaf posts its object', () => {
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


// A record Mutagen could not read stays in the grid rather than vanishing, showing what was
// stored and offering nothing that writes. Both columns here are tracked and mutable, so only
// the diagnosis can explain a read-only cell.
describe('RecordPanel — a column whose record failed to parse', () => {
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

  // commands.md, Record: a field gesture from the palette acts on the focused cell, so the panel
  // tells the host which cell that is, as the context its right-click hands the command.
  it('tells the host the focused cell\'s context when a cell takes the focus', async () => {
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

  // Copy value and the name filter act on the focused view: a background re-read that changes the
  // focused cell's text must not take that focus from the list the user is working in.
  it('tells the host a cell was entered on a click, and not when a re-read changes its text', async () => {
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

  // The array gestures are host commands gated on the row's own data-vscode-context, so a column
  // that offers no array section offers no Add/Remove/Move at all.
  it('offers no array right-click commands, where the readable column offers them', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const arraySections = (plugin: string) => contextsFor(container, plugin)
      .map(c => String(c.webviewSection)).filter(s => s.includes('array'));
    expect(arraySections('Broken.esp')).toEqual([]);
    expect(arraySections('Good.esp')).not.toEqual([]);
  });

  // ADR-0018 keeps Open in Editor… on a read-only column — it is the only way to read a long
  // value in full — so what has to be pinned is that it cannot write.
  it('marks the extended editor read-only on its string cells, where the readable column does not', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const stringContext = (plugin: string) => contextsFor(container, plugin)
      .find(c => String(c.webviewSection).includes('stringValue'));
    expect(stringContext('Broken.esp')?.readOnly).toBe(true);
    expect(stringContext('Good.esp')?.readOnly).toBe(false);
  });
});

// editor.md, The FormID: the first row of the grid, under Record Header, edited as any field is,
// and read-only on a plugin header. It reads as xEdit's does, as the record it names.
describe('RecordPanel — the Record Header', () => {
  const nameMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'string' });
  const native = (formKey: string, editorId: string | null): CompareResult => compareResultFixture({
    overrides: [
      compareOverride({
        formKey, plugin: 'MyMod.esp', isWinner: true, editorId,
        fields: [{ metadata: nameMeta, value: 'A Name' }],
      }),
    ],
    diffs: [diffNode({ fieldName: 'Name', values: { 'MyMod.esp': 'A Name' }, winnerColumn: 'MyMod.esp' })],
  });
  const tracked = [{ name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true }];

  const rows = (container: HTMLElement) => Array.from(container.querySelectorAll('tbody tr'));
  const rowLabels = (container: HTMLElement) =>
    rows(container).map(tr => tr.querySelector('td')?.textContent.replace(/^[▶▼]/, ''));
  const formIdCell = (container: HTMLElement) =>
    required(rows(container).find(tr => tr.querySelector('td')?.textContent === 'FormID')?.querySelectorAll('td')[1],
      'the FormID cell');

  afterEach(() => vi.unstubAllGlobals());

  it('is the grid\'s first row, with the FormID under it, reading as the record it names', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    expect(rowLabels(container)).toEqual(['Record Header', 'FormID', 'Name']);
    expect(formIdCell(container).textContent).toBe('MovedNpc [000800:MyMod.esp]');
  });

  it('opens on the FormKey and posts a set of the record\'s FormKey member with the one typed', async () => {
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

  // editor.md, Menus and keys: open field value is a text field's; the FormID reads as a reference.
  it('offers the FormID no open-field-value menu, where a text field offers one', async () => {
    vi.stubGlobal('mEditFormKey', '000800:MyMod.esp');
    const { container } = renderPanel(native('000800:MyMod.esp', 'MovedNpc'), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    const menuOf = (cell: Element) => cell.closest('[data-vscode-context]')?.getAttribute('data-vscode-context') ?? '';
    expect(menuOf(formIdCell(container))).not.toContain('stringValue');
    expect(menuOf(required(screen.getByText('A Name').closest('td'), "Name's cell"))).toContain('stringValue');
  });

  it('opens no editor on a plugin header\'s FormID, where its other fields open one', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { container } = renderPanel(native('000000:MyMod.esp', null), { plugins: tracked });
    await waitFor(() => screen.getByText('A Name'));

    fireEvent.doubleClick(within(formIdCell(container)).getByText('000000:MyMod.esp'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('A Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
