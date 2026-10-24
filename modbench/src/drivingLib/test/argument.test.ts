import { describe, it, expect } from 'vitest';
import { modArgumentOf, pluginArgumentOf } from '../argument';
import { recordArgumentOf } from '../recordArgument';

const plugin = { name: 'A.esp', origin: 'ModA' };

describe('the Argument a row or context carries', () => {
  it.each<[string, (carrier: unknown) => unknown, unknown, unknown]>([
    ['a mod', modArgumentOf, { argument: { kind: 'mod', name: 'ModA' } }, { kind: 'mod', name: 'ModA' }],
    ['a plugin', pluginArgumentOf, { argument: { kind: 'plugin', plugin } }, { kind: 'plugin', plugin }],
    ['a record in a plugin', recordArgumentOf, { argument: { kind: 'record', plugin, formKey: '000800:A.esp' } }, { kind: 'record', plugin, formKey: '000800:A.esp' }],
    ['a record by its FormKey alone', recordArgumentOf, { argument: { kind: 'record', formKey: '000800:A.esp' } }, { kind: 'record', formKey: '000800:A.esp' }],
    ['none for a mod read from a plugin', modArgumentOf, { argument: { kind: 'plugin', plugin } }, undefined],
    ['none for a plugin read from a mod', pluginArgumentOf, { argument: { kind: 'mod', name: 'ModA' } }, undefined],
    ['none for a record read from a plugin', recordArgumentOf, { argument: { kind: 'plugin', plugin } }, undefined],
    ['none for a record whose plugin names no origin', recordArgumentOf, { argument: { kind: 'record', plugin: { name: 'A.esp' }, formKey: '000800:A.esp' } }, undefined],
    ['none for a record that names no FormKey', recordArgumentOf, { argument: { kind: 'record', plugin } }, undefined],
    ['none for a record\'s fields carried bare, with no Argument', recordArgumentOf, { formKey: '000800:A.esp', plugin: 'A.esp', origin: 'ModA' }, undefined],
    ['none for a plugin named by its filename alone', pluginArgumentOf, { argument: { kind: 'plugin', plugin: 'A.esp' } }, undefined],
    ['none for a mod that names no mod', modArgumentOf, { argument: { kind: 'mod' } }, undefined],
    ['none for no carrier', modArgumentOf, undefined, undefined],
  ])('is %s', (_case, parse, carrier, expected) => {
    expect(parse(carrier)).toEqual(expected);
  });
});
