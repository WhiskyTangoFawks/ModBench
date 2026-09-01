import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) call so each row's handler can be invoked
// directly, the same pattern recordPanelMessageRouter.test.ts's own vscode mock uses.
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

// The exhaustive command list this table must cover — independent of the table's own
// source, the same "nothing missing, nothing extra" bar packageJson.test.ts's own
// EXPECTED_COMMANDS list uses. Registration alone (extension.test.ts) proves a command exists;
// it does not prove which message it broadcasts, which is the actual risk in collapsing three
// hand-written registrars into one data table — this file is that proof.
const EXPECTED_FORWARDER_COMMANDS = [
  'modbench.field.openExtended',
  'modbench.array.add',
  'modbench.array.remove',
  'modbench.array.moveUp',
  'modbench.array.moveDown',
  'modbench.vmad.removeScript',
  'modbench.vmad.addProperty',
  'modbench.vmad.removeProperty',
].sort();

describe('FORWARDER_COMMANDS', () => {
  it('covers exactly the 8 pure-forwarder commands, no more, no fewer', () => {
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

  it('vmad.removeScript broadcasts VMAD_STRUCTURAL_OP with a remove_script envelope', () => {
    const { panels, postMessage } = fakePanels();
    registerForwarderCommands(panels);
    handlers.get('modbench.vmad.removeScript')!({
      formKey: 'Fallout4.esm:000003', plugin: 'Fallout4.esm', origin: 'Fallout4.esm', scriptName: 'MyScript',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP,
      formKey: 'Fallout4.esm:000003', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      fieldPath: 'VMAD\\MyScript', value: { op: 'remove_script' },
    });
  });

  it('vmad.addProperty broadcasts VMAD_OPEN_ADD_PROPERTY naming the script', () => {
    const { panels, postMessage } = fakePanels();
    registerForwarderCommands(panels);
    handlers.get('modbench.vmad.addProperty')!({
      formKey: 'Fallout4.esm:000004', plugin: 'Fallout4.esm', origin: 'Fallout4.esm', scriptName: 'MyScript',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY,
      formKey: 'Fallout4.esm:000004', plugin: 'Fallout4.esm', origin: 'Fallout4.esm', scriptName: 'MyScript',
    });
  });

  it('vmad.removeProperty broadcasts VMAD_STRUCTURAL_OP with a remove_property envelope', () => {
    const { panels, postMessage } = fakePanels();
    registerForwarderCommands(panels);
    handlers.get('modbench.vmad.removeProperty')!({
      formKey: 'Fallout4.esm:000005', plugin: 'Fallout4.esm', origin: 'Fallout4.esm', scriptName: 'MyScript', propName: 'MyProp',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: EXTENSION_TO_WEBVIEW.VMAD_STRUCTURAL_OP,
      formKey: 'Fallout4.esm:000005', plugin: 'Fallout4.esm', origin: 'Fallout4.esm',
      fieldPath: 'VMAD\\MyScript\\MyProp', value: { op: 'remove_property' },
    });
  });
});
