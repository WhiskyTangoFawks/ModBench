import * as vscode from 'vscode';
import { isRefused, type MEditClient } from '../medit/client';
import { offerEslFlagRemoval } from '../medit/eslFlagRemovalPrompt';
import { resolveOrigin } from '../medit/resolveOrigin';
import { copyTargetPlugins, type CopyGesture } from './copyTargetPlugins';
import { renumberConfirmMessage } from './renumberConfirm';
import type { Reporter } from '../reporter';
import type { AskQuestion } from '../dialog';
import type { RecordTreeSync } from './onRecordEdited';

/** Read off whatever object a gesture is invoked with — a tree row from the Plugins view or a
 *  plain identity literal, the way `recordOpenIdentity` (recordPanelHost.ts) already reads an
 *  unknown node. Editor names no Plugins-view node type. */
export interface RecordIdentity {
  formKey: string;
  plugin: string;
  origin?: string;
  editorId?: string;
}

export function recordIdentity(arg: unknown): RecordIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as {
    record?: { formKey?: string; plugin?: string; editorId?: string | null };
    origin?: string; formKey?: string; plugin?: string; editorId?: string;
  };
  if (n.record) {
    if (!n.record.formKey || !n.record.plugin) return undefined;
    return { formKey: n.record.formKey, plugin: n.record.plugin, origin: n.origin, editorId: n.record.editorId ?? undefined };
  }
  if (!n.formKey || !n.plugin) return undefined;
  return { formKey: n.formKey, plugin: n.plugin, origin: n.origin, editorId: n.editorId };
}

export interface RecordTypeIdentity {
  plugin: string;
  origin?: string;
  recordType: string;
}

export function recordTypeIdentity(arg: unknown): RecordTypeIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const n = arg as { plugin?: string; origin?: string; recordType?: string };
  if (!n.plugin || !n.recordType) return undefined;
  return { plugin: n.plugin, origin: n.origin, recordType: n.recordType };
}

// A node's own `origin` when the row already carries it (ADR-0012), else derived from
// `getPlugins()`; reports and returns undefined when neither answers.
function makeResolveOriginOrReport(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: vscode.LogOutputChannel, reporter: Reporter,
): (node: { origin?: string; pluginName: string }) => Promise<string | undefined> {
  return async (node) => {
    const origin = node.origin ?? await resolveOrigin(client, node.pluginName, (msg) => outputChannel.info(msg));
    if (!origin) {
      reporter.report('error', `Could not resolve which mod "${node.pluginName}" belongs to.`);
    }
    return origin;
  };
}

type RecordLifecycleClient = Pick<MEditClient,
  | 'createRecord' | 'deleteRecord' | 'renumberRecord' | 'getPlugins' | 'peekNextFreeFormKey' | 'getReferences'
  // `editRecord`: create's own ESL-flag-removal retry (`offerEslFlagRemoval`), not a record write
  // of its own.
  | 'editRecord'>;

/** ADR-0018: xEdit hosts Add/Remove/Change FormID in its tree's context menu, not the grid, and
 *  the titles match its captions exactly. No ambient fallback is worth a QuickPick, so all three
 *  are palette-gated. */
export function registerRecordLifecycleCommands(
  client: RecordLifecycleClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  treeSync: RecordTreeSync, refreshMatchingPlugins: () => void,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(client, outputChannel, reporter);
  // A create/delete/renumber landed: the same re-derive every write in this file needs
  // (plugins.md) — a changed record can start or stop matching the active filter.
  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };

  return [
    // xEdit's own "Add": no prompt — a blank record appears immediately and is named afterward
    // by editing its EditorID, matching xEdit's own gesture.
    vscode.commands.registerCommand('modbench.record.create', async (arg?: unknown) => {
      const identity = recordTypeIdentity(arg);
      if (!identity) return;
      const origin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
      if (!origin) return;

      const result = await client.createRecord(
        identity.plugin, origin, identity.recordType, undefined, undefined,
        message => offerEslFlagRemoval({ name: identity.plugin, origin }, message, 'Create the Record', client, ask, reporter),
      );
      if (!result) return; // the ESL prompt was declined — nothing happened
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      onWritten();
      reporter.landed(`Added ${result.formKey}.`);
    }),

    // xEdit's own "Remove": MessageDlg('Are you sure you want to permanently remove <Name>?',
    // mtConfirmation, [mbYes, mbNo]) — the native modal equivalent, naming the same record identity
    // xEdit's own confirmation does, so the user confirms the right thing.
    vscode.commands.registerCommand('modbench.record.delete', async (arg?: unknown) => {
      const identity = recordIdentity(arg);
      if (!identity) return;
      const origin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
      if (!origin) return;

      const label = identity.editorId ? `${identity.editorId} [${identity.formKey}]` : identity.formKey;
      const choice = await ask(
        `Are you sure you want to permanently remove ${label}?`, { modal: true }, 'Remove',
      );
      if (choice !== 'Remove') return;

      const result = await client.deleteRecord(identity.formKey, identity.plugin, origin);
      if (!result) return;
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      onWritten();
    }),

    // xEdit's own "Change FormID": a native InputBox prefilled with the next-free suggestion, so
    // accepting the default is one Enter; typing over it is validated server-side.
    vscode.commands.registerCommand('modbench.record.renumber', async (arg?: unknown) => {
      const identity = recordIdentity(arg);
      if (!identity) return;
      const origin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
      if (!origin) return;

      let suggested: string | undefined;
      try {
        suggested = await client.peekNextFreeFormKey(identity.plugin, origin);
      } catch (e) {
        // Background/recoverable (ADR-0019): the input box still works with no prefill, so this is
        // a log line, not a toast — the command is not blocked on it.
        outputChannel.warn(`[recordLifecycleCommands] record.renumber could not fetch a suggested FormKey: ${e instanceof Error ? e.message : String(e)}`);
      }

      const input = await vscode.window.showInputBox({
        prompt: `New FormID for ${identity.formKey}`,
        value: suggested,
        valueSelection: undefined,
      });
      if (input === undefined) return; // cancelled

      // A renumber with referencers cascades behind one up-front confirm stating the blast radius.
      // A fetch failure degrades to a confirm with no counts: the backend re-checks referencers
      // regardless of what this preview said.
      let confirmMessage: string | null;
      try {
        confirmMessage = renumberConfirmMessage(
          identity.formKey, input || suggested || '(next free)', await client.getReferences(identity.formKey));
      } catch (e) {
        outputChannel.warn(`[recordLifecycleCommands] record.renumber could not fetch referencers for the confirm: ${e instanceof Error ? e.message : String(e)}`);
        confirmMessage = `Change FormID of ${identity.formKey}? Its references could not be counted — ` +
          'every referencing record in a tracked plugin will be updated with it.';
      }
      if (confirmMessage !== null) {
        const choice = await ask(confirmMessage, { modal: true }, 'Change FormID');
        if (choice !== 'Change FormID') return;
      }

      const result = await client.renumberRecord(identity.formKey, identity.plugin, origin, input || undefined);
      if (!result) return;
      if (isRefused(result)) { reporter.report('error', result.message); return; }
      onWritten();
      reporter.landed(`Renumbered to ${result.newFormKey}.`);
    }),
  ];
}

type RecordCopyClient = Pick<MEditClient,
  'copyRecordAsOverride' | 'copyRecordAsNewRecord' | 'getPlugins' | 'getRecordOverridePlugins' | 'editRecord'>;

// Returns the picked `PluginMetadata`, not just its name, so the caller reads `.origin` off it
// instead of a second round trip. Either call rejecting is caught wholesale: no fallback tier
// remains below this step.
async function pickCopyDestination(
  client: RecordCopyClient, gesture: CopyGesture, formKey: string, reporter: Reporter,
): Promise<{ name: string; origin: string } | undefined> {
  try {
    const allPlugins = await client.getPlugins();
    const carrying = gesture === 'copy-as-override' ? await client.getRecordOverridePlugins(formKey) : [];
    const candidates = copyTargetPlugins(allPlugins, gesture, carrying);
    if (candidates.length === 0) {
      // Nothing landed, but the reporter's information tier is `landed`: an unusable gesture says
      // so at the same level it always has, rather than toasting a warning the user cannot act on.
      reporter.landed('No eligible destination plugin for this copy.');
      return undefined;
    }
    const items = candidates.map((p) => ({ label: p.name, description: `[${p.loadOrderIndex}]`, plugin: p }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: gesture === 'copy-as-override' ? 'Copy as Override Into…' : 'Copy as New Record Into…',
    });
    return picked && { name: picked.plugin.name, origin: picked.plugin.origin };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // gesture goes in `detail`, not `message` — it's context for the Output channel, not
    // something the toast (already carrying `detail`) needs to repeat.
    reporter.report('error', `Could not look up destination plugins: ${detail}`, gesture);
    return undefined;
  }
}

// No confirmation modal: xEdit's CopyInto asks nothing before an override copy, and Copy as New
// Record prompts for neither an EditorID nor a FormKey — land immediately, rename via the grid.
async function runCopyRecordCommand(
  gesture: CopyGesture, arg: unknown, client: RecordCopyClient,
  resolveOriginOrReport: (node: { origin?: string; pluginName: string }) => Promise<string | undefined>,
  reporter: Reporter, ask: AskQuestion,
  onWritten: () => void,
): Promise<void> {
  const identity = recordIdentity(arg);
  if (!identity) return;
  const sourceOrigin = await resolveOriginOrReport({ origin: identity.origin, pluginName: identity.plugin });
  if (!sourceOrigin) return;

  const destination = await pickCopyDestination(client, gesture, identity.formKey, reporter);
  if (!destination) return;

  if (gesture === 'copy-as-override') {
    const result = await client.copyRecordAsOverride(identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin);
    if (!result) return;
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    onWritten();
    reporter.landed(`Copied ${identity.formKey} into ${destination.name}.`);
  } else {
    const result = await client.copyRecordAsNewRecord(
      identity.formKey, identity.plugin, sourceOrigin, destination.name, destination.origin, undefined,
      message => offerEslFlagRemoval(destination, message, 'Copy the Record', client, ask, reporter),
    );
    if (!result) return; // the ESL prompt was declined — nothing happened
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    onWritten();
    reporter.landed(`Copied as ${result.newFormKey} into ${destination.name}.`);
  }
}

// xEdit parity (xeMainForm.pas's CopyInto): one command per gesture, reached from a tree row or
// a column header alike — `arg` resolves to the same identity either way.
export function registerRecordCopyCommands(
  client: RecordCopyClient, outputChannel: vscode.LogOutputChannel,
  reporter: Reporter, ask: AskQuestion,
  treeSync: RecordTreeSync, refreshMatchingPlugins: () => void,
): vscode.Disposable[] {
  const resolveOriginOrReport = makeResolveOriginOrReport(client, outputChannel, reporter);
  // A copy lands as a working-tree change on the destination plugin — same reason create,
  // delete and renumber all re-derive the tree and the filter's matching-plugin set.
  const onWritten = () => { treeSync.refresh(); refreshMatchingPlugins(); };

  return [
    vscode.commands.registerCommand('modbench.record.copyAsOverride', async (arg?: unknown) => {
      await runCopyRecordCommand('copy-as-override', arg, client, resolveOriginOrReport, reporter, ask, onWritten);
    }),
    vscode.commands.registerCommand('modbench.record.copyAsNewRecord', async (arg?: unknown) => {
      await runCopyRecordCommand('copy-as-new', arg, client, resolveOriginOrReport, reporter, ask, onWritten);
    }),
  ];
}
