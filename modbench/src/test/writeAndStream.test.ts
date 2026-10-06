import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Range, uriFile, uriFrom, fakeUri } from './vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Range, Uri: { from: uriFrom, file: uriFile },
  WorkspaceEdit: class { renameFile() {} createFile() {} replace() {} },
  workspace: {
    openTextDocument: () => Promise.resolve({ getText: () => '{}', isDirty: true, save: () => Promise.resolve(true) }),
    applyEdit: () => Promise.resolve(true),
  },
}));

import { applyRecordEdit, oneAtATime, type RecordWriteDeps } from '../editor/applyRecordEdit';
import { RecordDecorationProvider } from '../plugins/RecordDecorationProvider';
import { PluginTreeProvider, RecordNode, RecordTypeNode } from '../plugins/PluginTreeProvider';
import { subscribeRecordPanelsToNotifications } from '../editor/notificationWiring';
import { EditsInFlight } from '../editor/followRecord';
import { subscribeTreeToNotifications } from '../plugins/treeNotifications';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { type RecordSummary } from '../client';
import { recordingReporter } from './surfacingDoubles';
import { recordTypeCountFixture } from '../client/test/fixtures';
import { expectInstanceOf } from './expectInstanceOf';
import { present } from '../ports/present';

function fakePanel(): { title: string; webview: { postMessage: ReturnType<typeof vi.fn> } } {
  return { title: '', webview: { postMessage: vi.fn() } };
}

function fakeActiveRecordTracker() {
  const formKeys = new Map<unknown, string>();
  return {
    setFormKey(panel: unknown, formKey: string) { formKeys.set(panel, formKey); },
    formKeyOf(panel: unknown) { return formKeys.get(panel); },
  };
}

const FORM_KEY = '000001:Test.esp';

function record(workingTreeState: RecordSummary['workingTreeState']): RecordSummary {
  return {
    formKey: FORM_KEY, plugin: 'Test.esp', loadOrderIndex: 0, isWinner: true, editorId: 'TestNpc', origin: 'ModA',
    workingTreeState, hasContainerChildren: false, hasParseFailure: false,
  };
}

const FILE = '/mods/ModA/plugin-source/Test.esp/Npcs/TestNpc.json';
const EDITED = { formKey: FORM_KEY, plugin: { name: 'Test.esp', origin: 'ModA' } };
const editDeps = (meditClient: InMemoryMEditClient): RecordWriteDeps => ({
  meditClient, refreshSourceControlFor: vi.fn(), reporter: recordingReporter(), moving: vi.fn(), oneAtATime: oneAtATime(),
  documentOf: () => Promise.resolve({ uri: fakeUri(FILE) }),
});
const landed = { applied: true as const, moves: [], documents: [{ path: FILE, text: '{"Height": 0.75}' }] };

const rowsChanged = () => ({ kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: [FORM_KEY], sequence: 1 });

const asVsCodeReReadsAnExpandedGroupOnTreeChange = (tree: PluginTreeProvider, group: RecordTypeNode) => tree.getChildren(group);

describe('a write and the stream, together: the write\'s own callback is silent and the stream is how the panel, the tree and the badge learn of it', () => {
  it('after a write, the panel re-reads exactly once, on rows-changed', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getEditChanges', landed);
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, FORM_KEY);
    subscribeRecordPanelsToNotifications(meditClient, recordPanels, new EditsInFlight(tracker));
    await applyRecordEdit(editDeps(meditClient), EDITED, { op: 'set', path: [] });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    meditClient.emit(rowsChanged());

    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: FORM_KEY });
  });

  it('a landed field edit touches neither the tree nor the badge; the M arrives with mEdit\'s changed rows', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setQueryAnswer('getEditChanges', landed);
    meditClient.setQueryAnswer('getRecords', { items: [record('None')], total: 1 });
    const tree = new PluginTreeProvider(meditClient);
    const badges = new RecordDecorationProvider(tree);
    subscribeTreeToNotifications(meditClient, tree, vi.fn());
    const group = new RecordTypeNode('Test.esp', recordTypeCountFixture({ type: 'NPC_', displayName: 'Non-Player Character' }), 'ModA');
    const uri = present(expectInstanceOf((await tree.getChildren(group))[0], RecordNode).resourceUri, "the row's resource URI");
    let treeChanges = 0;
    tree.onDidChangeTreeData(() => { treeChanges++; });
    const badgeChanges: unknown[] = [];
    badges.onDidChangeFileDecorations((changed) => { badgeChanges.push(changed); });

    await applyRecordEdit(editDeps(meditClient), EDITED, { op: 'set', path: [] });

    expect(treeChanges).toBe(0);
    expect(badgeChanges).toEqual([]);
    expect(badges.provideFileDecoration(uri)).toBeUndefined();

    meditClient.setQueryAnswer('getRecords', { items: [record('Modified')], total: 1 });
    meditClient.emit(rowsChanged());
    await asVsCodeReReadsAnExpandedGroupOnTreeChange(tree, group);

    expect(treeChanges).toBe(1);
    expect(badgeChanges).toEqual([[uri]]);
    expect(badges.provideFileDecoration(uri)?.badge).toBe('M');
  });
});
