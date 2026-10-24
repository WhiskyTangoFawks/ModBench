import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakePanel {
  title: string;
  disposed: boolean;
  dispose: () => void;
  onDidDispose: (listener: () => void) => void;
  webview: { postMessage: ReturnType<typeof vi.fn<(message: unknown) => Promise<boolean>>>; onDidReceiveMessage: (listener: (message: unknown) => void) => void; options: object; html: string; cspSource: string; asWebviewUri: (uri: unknown) => unknown };
  receive: (message: unknown) => void;
}

const { createWebviewPanel, panels } = vi.hoisted(() => {
  const made: FakePanel[] = [];
  return {
    panels: made,
    createWebviewPanel: vi.fn((_type: string, title: string): FakePanel => {
      let disposeListener = (): void => undefined;
      let messageListener: (message: unknown) => void = () => undefined;
      const panel: FakePanel = {
        title, disposed: false,
        dispose: () => { panel.disposed = true; disposeListener(); },
        onDidDispose: (listener) => { disposeListener = listener; },
        webview: {
          postMessage: vi.fn((_message: unknown) => Promise.resolve(true)), onDidReceiveMessage: (listener) => { messageListener = listener; },
          options: {}, html: '', cspSource: 'csp:', asWebviewUri: (uri) => uri,
        },
        receive: (message) => messageListener(message),
      };
      made.push(panel);
      return panel;
    }),
  };
});

vi.mock('vscode', () => ({
  window: { createWebviewPanel },
  ViewColumn: { Active: -1 },
  Uri: { file: (path: string) => ({ fsPath: path, path }), joinPath: (base: unknown, ...parts: string[]) => [String(base), ...parts].join('/') },
}));

import { fomodDialog } from '../fomodDialog';
import type { AskQuestion } from '../../ports/dialog';
import * as vscode from 'vscode';
import { FOMOD_MOVE, FOMOD_READY, FOMOD_STATE, type FomodMove, type FomodState } from '../../wire/fomodPage';

const EXTENSION = vscode.Uri.file('/ext');
const STATE: FomodState = { module: 'My Module', steps: [], current: 0 };
const page = () => {
  const [only] = panels;
  if (only === undefined) throw new Error('no page was opened');
  return only;
};

beforeEach(() => {
  panels.length = 0;
  createWebviewPanel.mockClear();
});

describe('the FOMOD installer\'s page, in a tab', () => {
  it('opens nothing until the installer has a state to show, then titles the tab by the module', () => {
    const dialog = fomodDialog(EXTENSION, vi.fn());
    expect(createWebviewPanel).not.toHaveBeenCalled();

    dialog.show(STATE);

    expect(page().title).toBe('FOMOD: My Module');
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it('sends the latest state once the page says it is ready, and each state after that as it comes', () => {
    const dialog = fomodDialog(EXTENSION, vi.fn());
    dialog.show(STATE);

    page().receive({ type: FOMOD_READY });
    dialog.show({ ...STATE, current: 1 });

    expect(page().webview.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: FOMOD_STATE, state: STATE }, { type: FOMOD_STATE, state: STATE }, { type: FOMOD_STATE, state: { ...STATE, current: 1 } },
    ]);
  });

  it('hands on the moves the page sends, and nothing else it says', () => {
    const moves: FomodMove[] = [];
    const dialog = fomodDialog(EXTENSION, vi.fn());
    dialog.onMove((move) => moves.push(move));
    dialog.show(STATE);

    page().receive({ type: FOMOD_MOVE, move: { kind: 'manual' } });
    page().receive({ type: 'other' });

    expect(moves).toEqual([{ kind: 'manual' }]);
  });

  it('takes closing the tab as Cancel, but not the close the installer asks for itself', () => {
    const moves: FomodMove[] = [];
    const closedByUser = fomodDialog(EXTENSION, vi.fn());
    closedByUser.onMove((move) => moves.push(move));
    closedByUser.show(STATE);
    page().dispose();

    expect(moves).toEqual([{ kind: 'cancel' }]);

    const closedByInstaller = fomodDialog(EXTENSION, vi.fn());
    closedByInstaller.onMove((move) => moves.push(move));
    closedByInstaller.show(STATE);
    closedByInstaller.close();

    expect(moves).toEqual([{ kind: 'cancel' }]);
    expect(panels[1]?.disposed).toBe(true);
  });

  it('names the missing files in a modal confirmation, and installs without them only on Install anyway', async () => {
    const ask = vi.fn<AskQuestion>().mockResolvedValueOnce('Install anyway').mockResolvedValueOnce(undefined);
    const dialog = fomodDialog(EXTENSION, ask);

    expect(await dialog.confirmMissing(['a.esp', 'b/c.esp'])).toBe(true);
    expect(await dialog.confirmMissing(['a.esp'])).toBe(false);

    expect(ask.mock.calls[0]).toEqual([expect.stringContaining('names files its archive does not hold'), { modal: true, detail: 'a.esp\nb/c.esp' }, 'Install anyway']);
  });
});
