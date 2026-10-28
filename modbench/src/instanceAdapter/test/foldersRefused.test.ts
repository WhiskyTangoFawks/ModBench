import { describe, expect, it } from 'vitest';
import { foldersRefused } from '../foldersRefused';

describe('the folders restore refuses', () => {
  it('joins every reason a folder has, since it can be outside the instance and hold another folder', async () => {
    const folders = new Map([['A', '/elsewhere/A'], ['B', '/elsewhere/A/B']]);

    expect(await foldersRefused('/instance', folders, ['A'])).toEqual([
      { item: 'A', reason: "was skipped: its folder '/elsewhere/A' is outside the instance folder; its folder holds the folder of 'B'." },
    ]);
  });

  it('answers only the manifests asked, though it compares them with every manifest', async () => {
    const folders = new Map([['A', '/instance/mods/A'], ['B', '/instance/mods/A/B'], ['C', '/instance/mods/C']]);

    expect(await foldersRefused('/instance', folders, ['B', 'C'])).toEqual([
      { item: 'B', reason: "was skipped: its folder is inside the folder of 'A'." },
    ]);
  });

  it('refuses a folder beside the instance folder whose name starts as the instance folder\'s does', async () => {
    expect(await foldersRefused('/instance', new Map([['A', '/instance-two/A']]), ['A'])).toEqual([
      { item: 'A', reason: "was skipped: its folder '/instance-two/A' is outside the instance folder." },
    ]);
  });
});
