import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import { applyRecordEdit } from '../../editor/applyRecordEdit';
import { RecordDecorationProvider } from '../../editor/RecordDecorationProvider';
import { PluginTreeProvider, RecordNode, RecordTypeNode } from '../../plugins/PluginTreeProvider';
import { subscribeRecordPanelsToNotifications, subscribeTreeToNotifications } from '../notificationWiring';
import { InMemoryMEditClient, type RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { recordTypeCountFixture } from '../../client/test/fixtures';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';

function fakePanel(): { webview: { postMessage: ReturnType<typeof vi.fn> } } {
  return { webview: { postMessage: vi.fn() } };
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

const rowsChanged = () => ({ kind: 'rows-changed', plugin: 'Test.esp', origin: 'ModA', keys: [FORM_KEY], sequence: 1 });

// ADR-0015 invariants 2 and 3: the write's own callback is silent; the stream is how the panel,
// the tree and the badge learn of it. Spans the port's notification wiring and Editor's own write.
describe('a write and the stream, together (ADR-0015 invariants 2 and 3)', () => {
  it('after a write, the panel re-reads exactly once, on rows-changed', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setCommandResult('editRecord', { applied: true });
    const panel = fakePanel();
    const recordPanels = new Set([panel]);
    const tracker = fakeActiveRecordTracker();
    tracker.setFormKey(panel, FORM_KEY);
    subscribeRecordPanelsToNotifications(meditClient, recordPanels, tracker, { holds: () => false, waitingFor: () => undefined, release: () => false });
    await applyRecordEdit(
      { meditClient, refreshSourceControlFor: vi.fn(), reporter: recordingReporter() }, FORM_KEY, 'Test.esp', 'ModA', { op: 'set', path: [] });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    meditClient.emit(rowsChanged());

    expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'loadRecord', formKey: FORM_KEY });
  });

  it('a landed field edit touches neither the tree nor the badge; the M arrives with mEdit\'s changed rows', async () => {
    const meditClient = new InMemoryMEditClient();
    meditClient.setCommandResult('editRecord', { applied: true });
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

    await applyRecordEdit(
      { meditClient, refreshSourceControlFor: vi.fn(), reporter: recordingReporter() },
      FORM_KEY, 'Test.esp', 'ModA', { op: 'set', path: [] });

    expect(treeChanges).toBe(0);
    expect(badgeChanges).toEqual([]);
    expect(badges.provideFileDecoration(uri)).toBeUndefined();

    meditClient.setQueryAnswer('getRecords', { items: [record('Modified')], total: 1 });
    meditClient.emit(rowsChanged());
    await tree.getChildren(group); // what VS Code does for an expanded group once the tree changes

    expect(treeChanges).toBe(1);
    expect(badgeChanges).toEqual([[uri]]);
    expect(badges.provideFileDecoration(uri)?.badge).toBe('M');
  });
});
