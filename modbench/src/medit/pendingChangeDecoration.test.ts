import { describe, it, expect } from 'vitest';
import { decorationKindFor, decorationDescriptorFor, type PendingChangeSummary, type RowIdentity } from './pendingChangeDecoration';

// #331: the pure row-identity + live-pending-change-state → decoration derivation. No vscode
// import anywhere in this file — the whole point is that this logic needs no harness.

function change(overrides: Partial<PendingChangeSummary> & { formKey: string; plugin: string }): PendingChangeSummary {
  return { changeType: 'field_edit', ...overrides };
}

describe('decorationKindFor — record rows', () => {
  it('undecorated when nothing is pending', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    expect(decorationKindFor([], row)).toBeUndefined();
  });

  it('modified when a field_edit change matches (plugin, formKey)', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'field_edit' })];
    expect(decorationKindFor(changes, row)).toBe('modified');
  });

  it('created when a create change matches', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'create' })];
    expect(decorationKindFor(changes, row)).toBe('created');
  });

  // ADR-0036: a row with an origin is a shadowed (permanently read-only) copy — it can never
  // truly have a pending change, even though its (formKey, plugin) pair collides with the
  // winning copy's, which really does.
  it('a shadowed-copy row (origin set) never decorates, even when the winning copy of the same formKey+plugin has a pending change', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp', origin: 'SomeMod' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'field_edit' })];
    expect(decorationKindFor(changes, row)).toBeUndefined();
  });

  it('does not match a change with the same formKey but a different plugin', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'Other.esp' })];
    expect(decorationKindFor(changes, row)).toBeUndefined();
  });

  it('does not match a change with the same plugin but a different formKey', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    const changes = [change({ formKey: '009999:MyPatch.esp', plugin: 'MyPatch.esp' })];
    expect(decorationKindFor(changes, row)).toBeUndefined();
  });

  // Plugin-filename comparisons are case-insensitive throughout this codebase (session files,
  // master issues, PluginsTreeComposite.setSession) — matching a change to a row must be too.
  it('matches the plugin name case-insensitively', () => {
    const row: RowIdentity = { kind: 'record', plugin: 'MyPatch.esp', formKey: '001234:MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MYPATCH.ESP' })];
    expect(decorationKindFor(changes, row)).toBe('modified');
  });
});

describe('decorationKindFor — plugin rows', () => {
  it('undecorated when the plugin has no pending changes', () => {
    const row: RowIdentity = { kind: 'plugin', plugin: 'MyPatch.esp' };
    expect(decorationKindFor([], row)).toBeUndefined();
  });

  it('modified when any contained record has a pending change', () => {
    const row: RowIdentity = { kind: 'plugin', plugin: 'MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'field_edit' })];
    expect(decorationKindFor(changes, row)).toBe('modified');
  });

  // Confirmed design choice (#331 review): uniform 'modified' at the plugin level even when the
  // only staged content is a creation — 'added' is reserved for the thing that is itself new
  // (matching git: a folder holding a new file still reads as modified, not added).
  it('modified, not created, when the plugin\'s only pending content is a creation', () => {
    const row: RowIdentity = { kind: 'plugin', plugin: 'MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MyPatch.esp', changeType: 'create' })];
    expect(decorationKindFor(changes, row)).toBe('modified');
  });

  it('does not decorate a plugin row from a different plugin\'s pending change', () => {
    const row: RowIdentity = { kind: 'plugin', plugin: 'MyPatch.esp' };
    const changes = [change({ formKey: '001234:Other.esp', plugin: 'Other.esp' })];
    expect(decorationKindFor(changes, row)).toBeUndefined();
  });

  it('matches the plugin name case-insensitively', () => {
    const row: RowIdentity = { kind: 'plugin', plugin: 'MyPatch.esp' };
    const changes = [change({ formKey: '001234:MyPatch.esp', plugin: 'MYPATCH.ESP' })];
    expect(decorationKindFor(changes, row)).toBe('modified');
  });
});

describe('decorationDescriptorFor', () => {
  it('undefined for no decoration', () => {
    expect(decorationDescriptorFor(undefined)).toBeUndefined();
  });

  it('modified: badge M, gitDecoration.modifiedResourceForeground', () => {
    const d = decorationDescriptorFor('modified');
    expect(d).toEqual({ badge: 'M', colorId: 'gitDecoration.modifiedResourceForeground', tooltip: expect.stringContaining('pending') });
  });

  it('created: badge A, gitDecoration.addedResourceForeground', () => {
    const d = decorationDescriptorFor('created');
    expect(d).toEqual({ badge: 'A', colorId: 'gitDecoration.addedResourceForeground', tooltip: expect.stringContaining('creation') });
  });
});
