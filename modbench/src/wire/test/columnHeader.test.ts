import { describe, it, expect } from 'vitest';
import { columnHeaderOf } from '../columnHeader';

const PLUGIN = { name: 'Second.esp', origin: 'ModA' };
const header = (argument: unknown, webviewSection = 'recordHeader') => ({
  webviewSection, argument, editable: false, preventDefaultContextMenuItems: true,
});

describe('a record tab\'s column header', () => {
  it('names the plugin of the record its Argument carries, at its own origin', () => {
    expect(columnHeaderOf(header({ kind: 'record', formKey: '000801:Second.esp', plugin: PLUGIN }))).toEqual(PLUGIN);
  });

  it.each([
    ['a context of another webview section', header({ kind: 'record', formKey: '000801:Second.esp', plugin: PLUGIN }, 'recordBody')],
    ['an Argument of another kind', header({ kind: 'plugin', formKey: '000801:Second.esp', plugin: PLUGIN })],
    ['an Argument with no FormKey', header({ kind: 'record', plugin: PLUGIN })],
    ['an Argument with no plugin', header({ kind: 'record', formKey: '000801:Second.esp' })],
    ['an Argument whose plugin has no origin', header({ kind: 'record', formKey: '000801:Second.esp', plugin: { name: 'Second.esp' } })],
    ['no Argument', header(undefined)],
    ['a row that is no context', 'recordHeader'],
  ])('names no plugin for %s', (_what, value) => {
    expect(columnHeaderOf(value)).toBeUndefined();
  });
});
