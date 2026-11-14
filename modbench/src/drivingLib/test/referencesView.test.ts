import { beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ enabled: true, changed: [] as (() => void)[] }));
vi.mock('vscode', () => ({
  extensions: {
    onDidChange: (listener: () => void) => { view.changed.push(listener); return { dispose: () => undefined }; },
    getExtension: (id: string) => (id === 'vscode.references-view' && view.enabled ? {} : undefined),
  },
}));

import { publishReferencesView } from '../referencesView';

beforeEach(() => { view.enabled = true; view.changed.length = 0; });

describe('publishReferencesView, for the menus that offer Referenced By', () => {
  it.each([[true], [false]])('publishes whether VS Code\'s References view is enabled (%s)', (enabled) => {
    view.enabled = enabled;
    const context = new Map<string, unknown>();

    publishReferencesView((key, value) => { context.set(key, value); });

    expect(context.get('modbench.referencesView')).toBe(enabled);
  });

  it('publishes it again when the extensions change', () => {
    const context = new Map<string, unknown>();
    publishReferencesView((key, value) => { context.set(key, value); });
    view.enabled = false;

    view.changed.forEach((listener) => { listener(); });

    expect(context.get('modbench.referencesView')).toBe(false);
  });
});
