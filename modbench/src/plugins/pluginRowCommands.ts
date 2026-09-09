import * as vscode from 'vscode';
import { EditingController } from '../medit/EditingController';
import { headerFormKeyFor } from './PluginTreeProvider';
import { ActiveRecordTracker } from '../medit/ActiveRecordTracker';
import { resolveCompileTarget } from '../medit/compileTarget';
import type { PluginRepository } from '../medit/PluginRepository';
import { makeMergeEditorOpener, compileAndReport, reportCompileTargetError } from '../medit/editorCommands';
import { runRebase } from './externalChangeGestures';
import { trackProgressMessage } from '../medit/trackProgress';
import { pluginFileOf, type PluginListNode } from '../modmanager/PluginListProvider';
import { makeReporter } from '../reporter';
import { withPluginsViewProgress, type ExtensionSession } from '../session';
import { say } from '../editingTeardown';

// Edits is the default `.gitignore` preset — Everything is the opt-in authoring choice. A
// mega-plugin's serialization is a one-time, worst-case tens-of-seconds cost (ADR-0041), so this
// runs under the Plugins-view progress indicator.
export function registerTrackCommand(
  session: ExtensionSession, controller: EditingController, outputChannel: vscode.LogOutputChannel, onTracked: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.track', async (node: PluginListNode | undefined) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      makeReporter(outputChannel, 'pluginListTree.track').report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Edits', description: 'Source only — recommended for downloaded mods' },
        { label: 'Everything', description: 'Source + assets — for authoring a mod from scratch' },
      ],
      { placeHolder: `Track "${name}" — what should its .gitignore include?` },
    );
    if (!choice) return;

    await withPluginsViewProgress(session, async () => {
      say(session, trackProgressMessage(origin, { phase: 'Idle', pluginsDone: 0, pluginsTotal: 0 }));
      const ok = await controller.track(origin, choice.label as 'Edits' | 'Everything', {
        onProgress: (status) => say(session, trackProgressMessage(origin, status)),
      });
      if (!ok) return;
      void vscode.window.showInformationMessage(`Modbench: Tracked "${origin}".`);
      await onTracked();
    });
  });
}

// Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. Also the
// *re-runnable* form — {@link SourceRepository.RebaseEditBranch}'s resumption-aware design means
// this same command both starts a rebase and resumes one left conflicted.
export function registerRebaseCommand(
  controller: EditingController, repository: PluginRepository, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.rebase', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const origin = await controller.resolveOrigin(name);
    if (!origin) {
      makeReporter(outputChannel, 'pluginListTree.rebase').report('error', `Could not resolve which mod "${name}" belongs to.`);
      return;
    }

    const result = await runRebase({ controller, openMergeEditor: makeMergeEditorOpener(repository, outputChannel) }, origin);
    if (!result) return; // transport failure already surfaced by EditingController

    if (result.outcome === 'Refused') {
      void vscode.window.showWarningMessage(`Modbench: ${result.refusalReason ?? 'Rebase refused.'}`);
    } else if (result.outcome === 'Clean') {
      void vscode.window.showInformationMessage(`Modbench: Rebased "${origin}" onto the updated baseline.`);
    } else {
      void vscode.window.showWarningMessage(
        `Modbench: Rebasing "${origin}" hit conflicts — resolve them in the opened merge editor(s), ` +
          'then run "Modbench: Rebase onto Updated Baseline" again to continue.',
      );
    }
  });
}

// Reachable from a plugin row, from the record editor's title bar (the *active* record's owning
// plugin — never a QuickPick, which risks compiling the wrong plugin), and from the palette
// (QuickPick fallback only when neither is in hand).
export function registerSaveAndCompileCommand(
  controller: EditingController,
  repository: PluginRepository,
  activeRecordTracker: ActiveRecordTracker<vscode.WebviewPanel>,
  outputChannel: vscode.LogOutputChannel,
  diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.saveAndCompile', async (node?: PluginListNode) => {
    const target = await resolveCompileTarget(
      node?.kind === 'plugin' ? node.plugin.name : undefined,
      activeRecordTracker.current(),
      {
        resolveOrigin: (name) => controller.resolveOrigin(name),
        getRecordOwner: (formKey) => repository.getRecordOwner(formKey),
        onError: (message) => reportCompileTargetError(outputChannel, 'saveAndCompile', message),
        pickPlugin: async () => {
          const plugins = await repository.getPlugins();
          const choice = await vscode.window.showQuickPick(
            plugins.map((p) => ({ label: p.name, description: p.origin })),
            { placeHolder: 'Save & Compile which plugin?' },
          );
          if (!choice) return undefined;
          if (!choice.description) {
            reportCompileTargetError(outputChannel, 'saveAndCompile', `"${choice.label}" has no mod folder to compile into.`);
            return undefined;
          }
          return { name: choice.label, origin: choice.description };
        },
      },
    );
    if (!target) return;

    await compileAndReport(controller, diagnostics, target, undefined, repository);
  });
}

// One confirmation names the ref literally, never "pristine" — there is no stored mode
// (ADR-0041). Tree-row only: naming a ref with no plugin in hand isn't worth a QuickPick.
export function registerCompileAtRefCommand(
  controller: EditingController, repository: PluginRepository,
  outputChannel: vscode.LogOutputChannel, diagnostics: vscode.DiagnosticCollection,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.pluginListTree.compileAtMain', async (node?: PluginListNode) => {
    if (node?.kind !== 'plugin') return;
    const target = await resolveCompileTarget(node.plugin.name, undefined, {
      resolveOrigin: (name) => controller.resolveOrigin(name),
      getRecordOwner: () => Promise.resolve(undefined),
      onError: (message) => reportCompileTargetError(outputChannel, 'compileAtMain', message),
      pickPlugin: () => Promise.resolve(undefined),
    });
    if (!target) return;

    const confirmed = await vscode.window.showWarningMessage(
      `Compile "${target.name}" at ref "main"?`,
      {
        modal: true,
        detail: `This overwrites the binary with what "main" holds, without touching your edit branch. ` +
          `Your working-tree changes stay exactly where they are.`,
      },
      'Compile at main',
    );
    if (confirmed !== 'Compile at main') return;

    await compileAndReport(controller, diagnostics, target, 'main', repository);
  });
}

// A join, not an Editing-only gesture (its argument is Mod Management's own row type), so it
// lives alongside the other plugin-row commands rather than with the record panel's own.
export function registerOpenHeaderCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.openHeader', (node?: PluginListNode) => {
    const pluginName = node && pluginFileOf(node);
    if (!pluginName) return;
    void vscode.commands.executeCommand('modbench.openEditor', {
      formKey: headerFormKeyFor(pluginName), label: pluginName,
    });
  });
}
