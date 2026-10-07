import type { GameFolder, InstanceValue } from '../instanceLoader/instance';

function lineFor(gameFolder: Extract<GameFolder, { kind: 'notFound' }>): string {
  const looked = gameFolder.looked.map(({ place, answer }) => `${place}: ${answer}`).join('; ');
  return `[instance] Game folder not found. Modbench looked at: ${looked}. Set ${gameFolder.setting} to the game folder to fix it.`;
}

export function gameFolderNotFoundLine({ gameFolder }: InstanceValue): string | undefined {
  return gameFolder.kind === 'found' ? undefined : lineFor(gameFolder);
}
