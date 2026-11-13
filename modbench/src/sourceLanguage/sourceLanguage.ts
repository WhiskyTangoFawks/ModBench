import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { commandLink } from '../drivingLib/quickFixes';
import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { isPluginSourcePath, PLUGIN_SOURCE_GLOB } from '../instanceAdapter/instanceAdapter';
import { readHeldText } from '../textDocuments/pluginSource';
import { handUnsavedPluginSource } from './handUnsaved';
import { registerBuildEntryPoint } from './buildEntryPoint';
import { registerUpdateManifestEntryPoint } from './updateManifestEntryPoint';
import type { Instance } from '../instanceLoader/instance';
import { feedSourceProblems, type ProblemOnFile, type SourceProblemsDeps } from './sourceProblems';
import { mergedFeeds } from './feedShape';
import { feedPathProblems, type PathProblemsDeps, type PathStanding } from './pathProblems';
import { feedWorkspaceNotice } from './workspaceNotice';

interface SourceLanguageDeps extends Pick<SourceProblemsDeps, 'sourceFiles'> {
  instance: Pick<Instance, 'value' | 'subscribe'> | undefined;
  reporter: Pick<Reporter, 'shownOnSurface' | 'report'>;
  client: Pick<MEditClient, 'handUnsavedDocuments'> & SourceProblemsDeps['client'] & PathProblemsDeps['client'];
  /** What holds a path a plugin source names. */
  pathStanding: PathStanding;
}

const pluginSourceStatusSelector: vscode.DocumentSelector = { language: 'json', pattern: PLUGIN_SOURCE_GLOB };

function diagnosticOf({ message, start, end, clearing }: ProblemOnFile): vscode.Diagnostic {
  const diagnostic = modbenchDiagnostic(new vscode.Range(start.line, start.character, end.line, end.character), message, vscode.DiagnosticSeverity.Warning);
  if (clearing) diagnostic.code = commandLink(clearing.label, clearing.command, clearing.args);
  return diagnostic;
}

interface SourceLanguage extends vscode.Disposable {
  messages(): string[];
}

function workspaceNotice(instance: SourceLanguageDeps['instance']): vscode.Disposable {
  if (instance === undefined) return new vscode.Disposable(() => undefined);
  const status = languageStatusItem('modbench.gameFolderOutside');
  const stop = feedWorkspaceNotice({ instance, languageStatus: status.show });
  return new vscode.Disposable(() => { stop(); status.dispose(); });
}

function languageStatusItem(id: string) {
  let item: vscode.LanguageStatusItem | undefined;
  return {
    show: (text: string | undefined) => {
      if (text === undefined) { item?.dispose(); item = undefined; return; }
      item ??= vscode.languages.createLanguageStatusItem(id, pluginSourceStatusSelector);
      item.severity = vscode.LanguageStatusSeverity.Warning;
      item.text = text;
    },
    text: (): string[] => (item === undefined ? [] : [item.text]),
    dispose: () => { item?.dispose(); },
  };
}

function sourceProblems(deps: SourceLanguageDeps): Pick<SourceLanguage, 'dispose' | 'messages'> {
  const collection = vscode.languages.createDiagnosticCollection('modbench-source');
  const feedOf = mergedFeeds((file, onFile) => {
    if (onFile.length === 0) collection.delete(vscode.Uri.file(file));
    else collection.set(vscode.Uri.file(file), onFile.map(diagnosticOf));
  });
  const linkStatus = languageStatusItem('modbench.sourceProblems');
  const pathStatus = languageStatusItem('modbench.sourcePaths');
  const readText = readHeldText;
  const unsubscribe = [
    feedSourceProblems({ ...deps, publish: feedOf('links'), languageStatus: linkStatus.show }),
    feedPathProblems({ ...deps, paths: deps.pathStanding, readText, publish: feedOf('paths'), languageStatus: pathStatus.show }),
  ];
  const disposable = new vscode.Disposable(() => { for (const off of unsubscribe) off(); collection.dispose(); linkStatus.dispose(); pathStatus.dispose(); });
  return { dispose: () => { disposable.dispose(); }, messages: () => [...linkStatus.text(), ...pathStatus.text()] };
}

export function createSourceLanguage(deps: SourceLanguageDeps): SourceLanguage {
  const problems = sourceProblems(deps);
  const entryPoints = deps.instance ? [registerBuildEntryPoint({ instance: deps.instance, reporter: deps.reporter }), registerUpdateManifestEntryPoint({ instance: deps.instance, reporter: deps.reporter })] : [];
  const disposable = vscode.Disposable.from(
    handUnsavedPluginSource(deps.client, isPluginSourcePath),
    problems, workspaceNotice(deps.instance), ...entryPoints,
  );
  return { dispose: () => { disposable.dispose(); }, messages: () => problems.messages() };
}
