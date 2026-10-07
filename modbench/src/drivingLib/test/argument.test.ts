import { describe, it, expect } from 'vitest';
import { modArgumentOf, pluginArgumentOf } from '../argument';
import { recordArgumentOf } from '../recordArgument';

const plugin = { name: 'A.esp', origin: 'ModA' };

describe('the Argument a row or context carries', () => {
  it('is read whatever box built the carrier', () => {
    expect(modArgumentOf({ argument: { kind: 'mod', name: 'ModA' } })).toEqual({ kind: 'mod', name: 'ModA' });
    expect(pluginArgumentOf({ argument: { kind: 'plugin', plugin } })).toEqual({ kind: 'plugin', plugin });
    expect(recordArgumentOf({ argument: { kind: 'record', plugin, formKey: '000800:A.esp' } }))
      .toEqual({ kind: 'record', plugin, formKey: '000800:A.esp' });
    expect(recordArgumentOf({ argument: { kind: 'record', formKey: '000800:A.esp' } })).toEqual({ kind: 'record', formKey: '000800:A.esp' });
  });

  it('is none for a carrier of another kind of object', () => {
    expect(modArgumentOf({ argument: { kind: 'plugin', plugin } })).toBeUndefined();
    expect(pluginArgumentOf({ argument: { kind: 'mod', name: 'ModA' } })).toBeUndefined();
    expect(recordArgumentOf({ argument: { kind: 'plugin', plugin } })).toBeUndefined();
  });

  it('is none when the Argument does not parse, such as a record that names no origin', () => {
    expect(recordArgumentOf({ argument: { kind: 'record', plugin: { name: 'A.esp' }, formKey: '000800:A.esp' } })).toBeUndefined();
    expect(recordArgumentOf({ argument: { kind: 'record', plugin } })).toBeUndefined();
    expect(recordArgumentOf({ formKey: '000800:A.esp', plugin: 'A.esp', origin: 'ModA' })).toBeUndefined();
    expect(pluginArgumentOf({ argument: { kind: 'plugin', plugin: 'A.esp' } })).toBeUndefined();
    expect(modArgumentOf({ argument: { kind: 'mod' } })).toBeUndefined();
    expect(modArgumentOf(undefined)).toBeUndefined();
  });
});
