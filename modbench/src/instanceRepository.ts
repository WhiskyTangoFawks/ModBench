import * as vscode from 'vscode';
import type { MakeRepository } from './ports/repository';

// The members of VS Code's git API this calls; `init` resolves null when git declined.
interface GitApi {
  init(root: vscode.Uri): Thenable<unknown>;
}
interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/** Makes `folder` a repository through VS Code's git, which Source Control then shows. */
export const initRepositoryIn: MakeRepository = async (folder) => {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (extension === undefined) throw new Error("VS Code's git extension is not available.");
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (await exports.getAPI(1).init(vscode.Uri.file(folder)) === null) throw new Error(`VS Code's git did not make ${folder} a repository.`);
};
