import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { CompareOverride, CompareResult, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, panelClient, parseJsonRecord, required, type FixturePlugin,
} from './test/fixtures';

const FORM_KEY = '000001:Fallout4.esm';
const TEMPLATE = '000801:Fallout4.esm';
const MASTER = 'Fallout4.esm';
const MOD = 'MyMod.esp';
const PLUGINS: FixturePlugin[] = [{ name: MASTER, isImmutable: true }, { name: MOD, isCompiledPlugin: true }];
const RESOLVED: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'EncRaider01' };
const UNRESOLVED: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

const levelMeta = fieldMeta({ name: 'Level', type: 'int' });
const aiMeta = fieldMeta({ name: 'AIData', type: 'struct', fields: [fieldMeta({ name: 'Aggression', type: 'int' })] });

function panelOf(
  meta: FieldMetadata, own: [unknown, unknown], diff: FieldDiff, templated: [CompareOverride['templated'], CompareOverride['templated']],
): CompareResult {
  return compareResultFixture({
    overrides: [MASTER, MOD].map((plugin, column) => compareOverride({
      formKey: FORM_KEY, plugin, isWinner: column === 1, editorId: 'RaiderTemplated',
      fields: [{ metadata: meta, value: own[column] }], templated: templated[column],
    })),
    diffs: [diff],
  });
}

const byTraits = (resolution: FormKeyResolution = RESOLVED) => ({ Level: { flag: 'Traits', template: TEMPLATE, resolution } });
const levelPanel = (templated: [CompareOverride['templated'], CompareOverride['templated']]) => panelOf(
  levelMeta, [5, 7], diffNode({ fieldName: 'Level', values: { [MASTER]: 5, [MOD]: 7 }, winnerColumn: MOD }), templated);

const renderPanel = (compare: CompareResult) => render(<RecordPanel client={panelClient(() => compare, { plugins: PLUGINS })} />);
const cellAt = (label: string, index: number) =>
  required(required(screen.getByText(label).closest('tr'), `the ${label} row`).querySelectorAll('td')[index], `the ${label} row's cell ${index}`);
const contextOf = (cell: Element) =>
  parseJsonRecord(required(cell.getAttribute('data-vscode-context'), "the cell's data-vscode-context attribute"));

beforeEach(() => vi.stubGlobal('mEditFormKey', FORM_KEY));
afterEach(() => vi.unstubAllGlobals());

describe('RecordPanel — a templated field', () => {
  it('reads from its template, as a reference reads, and never as its own value', async () => {
    renderPanel(levelPanel([null, byTraits()]));
    await screen.findByText('Level');
    expect(cellAt('Level', 2)).toHaveTextContent(/^from EncRaider01$/);
    expect(cellAt('Level', 1)).toHaveTextContent(/^5$/);
  });

  it('reads from the template\'s FormKey when the template resolves to no record', async () => {
    renderPanel(levelPanel([null, byTraits(UNRESOLVED)]));
    await screen.findByText('Level');
    expect(cellAt('Level', 2)).toHaveTextContent(new RegExp(`^from ${TEMPLATE}$`));
  });

  it('names the flag, the template and its own value in its tooltip, and in a column that can be edited how to edit it', async () => {
    renderPanel(levelPanel([byTraits(), byTraits()]));
    await screen.findByText('Level');
    const editable = required(cellAt('Level', 2).getAttribute('title'), 'the editable cell\'s tooltip');
    const immutable = required(cellAt('Level', 1).getAttribute('title'), 'the immutable cell\'s tooltip');
    expect(editable).toContain(`Templated by Traits from EncRaider01 [${TEMPLATE}]`);
    expect(editable).toContain('Its own value: 7');
    expect(editable).toContain('Clearing Traits makes it editable.');
    expect(immutable).toContain('Its own value: 5');
    expect(immutable).not.toContain('Clearing');
  });

  it('keeps its own check error beside the reading', async () => {
    renderPanel(panelOf(
      levelMeta, [5, 7],
      diffNode({ fieldName: 'Level', values: { [MASTER]: 5, [MOD]: 7 }, winnerColumn: MOD, checkErrors: { [MOD]: 'Level: out of range' } }),
      [null, byTraits()]));
    await screen.findByText('Level');
    expect(within(cellAt('Level', 2)).getByRole('img', { name: 'warning' })).toHaveAttribute('title', 'Level: out of range');
  });

  it('offers go to record on its template', async () => {
    renderPanel(levelPanel([null, byTraits()]));
    await screen.findByText('Level');
    const menu = contextOf(cellAt('Level', 2));
    expect(menu.webviewSection).toEqual(expect.stringMatching(/\breference\b/));
    expect(menu.referenceTarget).toBe(TEMPLATE);
  });

  it('offers no go to record on a template that resolves to no record', async () => {
    renderPanel(levelPanel([null, byTraits(UNRESOLVED)]));
    await screen.findByText('Level');
    expect(contextOf(cellAt('Level', 2)).webviewSection).not.toEqual(expect.stringMatching(/\breference\b/));
  });

  it('reads from its template on every row below it, collapsed or expanded', async () => {
    const aggression = diffNode({ fieldName: 'Aggression', values: { [MASTER]: 1, [MOD]: 2 }, winnerColumn: MOD });
    renderPanel(panelOf(
      aiMeta, [{ Aggression: 1 }, { Aggression: 2 }],
      diffNode({ fieldName: 'AIData', values: { [MASTER]: { Aggression: 1 }, [MOD]: { Aggression: 2 } }, winnerColumn: MOD, children: [aggression] }),
      [null, { AIData: { flag: 'AIData', template: TEMPLATE, resolution: RESOLVED } }]));
    await screen.findByText('Aggression');
    expect(cellAt('AIData', 2)).toHaveTextContent(/^from EncRaider01$/);
    expect(cellAt('Aggression', 2)).toHaveTextContent(/^from EncRaider01$/);
    expect(cellAt('Aggression', 1)).toHaveTextContent(/^1$/);
  });

  it('reads from its template where its copy holds no value of its own', async () => {
    const destructibleMeta = fieldMeta({ name: 'Destructible', type: 'struct', allowsNull: true, fields: [fieldMeta({ name: 'Health', type: 'int' })] });
    const health = diffNode({ fieldName: 'Health', values: { [MASTER]: 9 }, winnerColumn: MASTER });
    renderPanel(panelOf(
      destructibleMeta, [{ Health: 9 }, undefined],
      diffNode({ fieldName: 'Destructible', values: { [MASTER]: { Health: 9 } }, winnerColumn: MASTER, children: [health] }),
      [null, { Destructible: { flag: 'Traits', template: TEMPLATE, resolution: RESOLVED } }]));
    await screen.findByText('Health');
    expect(cellAt('Destructible', 2)).toHaveTextContent(/^from EncRaider01$/);
    expect(cellAt('Health', 2)).toHaveTextContent(/^$/);
    expect(cellAt('Destructible', 2).getAttribute('title')).not.toContain('Its own value');
  });

  it('reads from its template on a struct member\'s row, and leaves the struct\'s own row its own', async () => {
    const configMeta = fieldMeta({ name: 'Configuration', type: 'struct', fields: [levelMeta] });
    const level = diffNode({ fieldName: 'Level', values: { [MASTER]: 5, [MOD]: 7 }, winnerColumn: MOD });
    renderPanel(panelOf(
      configMeta, [{ Level: 5 }, { Level: 7 }],
      diffNode({ fieldName: 'Configuration', values: { [MASTER]: { Level: 5 }, [MOD]: { Level: 7 } }, winnerColumn: MOD, children: [level] }),
      [null, { 'Configuration.Level': { flag: 'Stats', template: TEMPLATE, resolution: RESOLVED } }]));
    await screen.findByText('Level');
    expect(cellAt('Level', 2)).toHaveTextContent(/^from EncRaider01$/);
    expect(cellAt('Configuration', 2)).not.toHaveTextContent(/from/);
  });
});
