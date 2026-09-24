import type * as vscode from 'vscode';
import type { GameFolder, InstanceView } from './instanceLoader/instance';

function lineFor(gameFolder: Extract<GameFolder, { kind: 'notFound' }>): string {
  const looked = gameFolder.looked.map(({ place, answer }) => `${place}: ${answer}`).join('; ');
  return `Game folder not found. Modbench looked at: ${looked}. Set ${gameFolder.setting} to the game folder to fix it.`;
}

/** One Output line per failure however many views show it (common.md, States, story 5). A folder
 *  lost again after being found, or looked for somewhere else, is a new failure. */
export function logGameFolderNotFound(
  instance: Pick<InstanceView, 'subscribe'>, log: (line: string) => void,
): vscode.Disposable {
  let reported: string | undefined;
  return instance.subscribe(({ gameFolder }) => {
    const line = gameFolder.kind === 'found' ? undefined : lineFor(gameFolder);
    if (line !== undefined && line !== reported) log(line);
    reported = line;
  });
}
