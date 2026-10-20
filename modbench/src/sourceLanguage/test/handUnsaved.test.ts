import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ unsaved: [] as { path: string; text: string }[], changed: undefined as (() => void) | undefined }));

vi.mock('../../textDocuments/pluginSource', () => ({
  unsavedPluginSource: () => h.unsaved,
  onPluginSourceChanged: (_isPluginSource: unknown, changed: () => void) => { h.changed = changed; return { dispose: () => undefined }; },
}));

import { handUnsavedPluginSource } from '../handUnsaved';

describe('handing mEdit the unsaved plugin source', () => {
  it('hands it now, and again whenever Text documents reports it changed', () => {
    const handed: unknown[] = [];
    h.unsaved = [{ path: '/a.json', text: 'first' }];
    handUnsavedPluginSource({ handUnsavedDocuments: (documents) => { handed.push(documents); } }, () => true);
    h.unsaved = [{ path: '/a.json', text: 'second' }];
    h.changed?.();

    expect(handed).toEqual([[{ path: '/a.json', text: 'first' }], [{ path: '/a.json', text: 'second' }]]);
  });
});
