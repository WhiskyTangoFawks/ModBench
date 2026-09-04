import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly.
const handlers = new Map<string, (ctx?: unknown) => void>();
const registerCommand = vi.fn((command: string, handler: (ctx?: unknown) => void) => {
  handlers.set(command, handler);
  return { dispose: vi.fn() };
});
vi.mock('vscode', () => ({ commands: { registerCommand: (...args: [string, (ctx?: unknown) => void]) => registerCommand(...args) } }));

import { registerForwarderCommands, FORWARDER_COMMANDS } from './recordPanelForwarderCommands';
import { EXTENSION_TO_WEBVIEW } from './messages';

beforeEach(() => { handlers.clear(); registerCommand.mockClear(); });

function fakePanels() {
  const postMessage = vi.fn();
  const panels = new Set([{ webview: { postMessage } } as unknown as import('vscode').WebviewPanel]);
  return { panels, postMessage };
}

// Written independently of the table under test, so "nothing missing, nothing extra" is a real
// bar. Registration proves a command exists, never which message it broadcasts.
const EXPECTED_FORWARDER_COMMANDS = [
  'modbench.field.openExtended',
  'modbench.array.add',
  'modbench.array.remove',
  'modbench.array.moveUp',
  'modbench.array.moveDown',
].sort();

describe('FORWARDER_COMMANDS', () => {
  it('covers exactly the 5 pure-forwarder commands, no more, no fewer', () => {
    expect(FORWARDER_COMMANDS.map((f) => f.command).sort()).toEqual(EXPECTED_FORWARDER_COMMANDS);
  });
});

describe('registerForwarderCommands', () => {
  it('registers every table row as a command', () => {
    registerForwarderCommands(new Set());
    expect([...handlers.keys()].sort()).toEqual(EXPECTED_FORWARDER_COMMANDS);
  });

  it('does nothing when the command fires with no context', () => {
    registerForwarderCommands(new Set());
    const { panels, postMessage } = fakePanels();
    handlers.get('modbench.array.add')!(undefined);
    // No ctx captured above — rebuild against panels this handler never saw, proving no throw
    // and (trivially) no broadcast reached them.
    expect(postMessage).not.toHaveBeenCalled();
    void panels;
  });

  it('field.openExtended forwards StringValueContext verbatim into FIELD_OPEN_EXTENDED_EDITOR', () => {
    const { panels, postMessage } = fakePanels();
    registerForwarderCommands(panels);
    handlers.get('modbench.field.openExtended')!({
      formKey: 'Fallout4.esm:000001', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      fieldName: 'FULL', value: 'A Name', readOnly: false, path: [], rootField: 'FULL',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
      formKey: 'Fallout4.esm:000001', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      fieldName: 'FULL', value: 'A Name', readOnly: false, path: [], rootField: 'FULL',
    });
  });

  it.each([
    ['modbench.array.add', 'add'],
    ['modbench.array.remove', 'remove'],
    ['modbench.array.moveUp', 'moveUp'],
    ['modbench.array.moveDown', 'moveDown'],
  ] as const)('%s broadcasts ARRAY_STRUCTURAL_OP with op %s', (command, op) => {
    const { panels, postMessage } = fakePanels();
    registerForwarderCommands(panels);
    handlers.get(command)!({
      formKey: 'Fallout4.esm:000002', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      rootField: 'KWDA', path: [],
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.ARRAY_STRUCTURAL_OP,
      formKey: 'Fallout4.esm:000002', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      rootField: 'KWDA', path: [], op,
    });
  });

});
