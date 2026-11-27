import { describe, it, expect, vi, beforeEach } from 'vitest';
import { editorVscode, fileSystems, textDocuments } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { changeNamesPlugin } from '../../client/test/says';
import { editorOver, forgetEditor } from './editorHarness';

const PLACED = '000803:A.esp';
const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';
const CHILD = editorVscode.Uri.from({ scheme: 'modbench-child-record', path: CELL_FILE, query: 'formKey=000803%3AA.esp&name=A.esp&origin=ModA' });

interface ChildFileSystem { onDidChangeFile(listener: (events: { uri: unknown }[]) => void): unknown }
const isChildFileSystem = (value: unknown): value is ChildFileSystem => typeof value === 'object' && value !== null && 'onDidChangeFile' in value;

beforeEach(forgetEditor);

async function following() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: CELL_FILE });
  const { openDocument } = editorOver({ meditClient: client });
  await openDocument(CHILD, { isDirty: false, getText: () => '{}' });
  textDocuments.push({ uri: CHILD });
  const fileSystem = fileSystems.get('modbench-child-record');
  if (!isChildFileSystem(fileSystem)) throw new Error('no child record file system registered');
  const children: unknown[] = [];
  fileSystem.onDidChangeFile((events) => { children.push(...events.map(({ uri }) => uri)); });
  const carrierAsked = () => client.calls.filter(({ method }) => method === 'getCopyDocument').map(({ args }) => args);
  return { client, children, carrierAsked };
}

describe('the copies a report changes, for the child documents and the carrier alike', () => {
  const reports: [string, (client: InMemoryMEditClient) => void, unknown][] = [
    ['rows changed in its plugin', (c) => { changeNamesPlugin(c, { name: 'A.esp', origin: 'ModA' }, ['000804:A.esp']); },
      { children: [CHILD], carrier: [[{ name: 'A.esp', origin: 'ModA' }, PLACED]] }],
    ['rows changed in another plugin of the same name', (c) => { changeNamesPlugin(c, { name: 'A.esp', origin: 'ModB' }, [PLACED]); },
      { children: [], carrier: [] }],
  ];

  it.each(reports)('%s', async (_name, report, changed) => {
    const { client, children, carrierAsked } = await following();

    report(client);

    expect({ children, carrier: carrierAsked() }).toEqual(changed);
  });
});
