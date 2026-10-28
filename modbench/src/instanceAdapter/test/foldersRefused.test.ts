import { describe, expect, it } from 'vitest';
import { foldersRefused } from '../foldersRefused';

describe('the folders restore refuses', () => {
  it('joins every reason a folder has, since it can be outside the instance and built by another manifest too', async () => {
    const folders = new Map([['A', '/elsewhere/A'], ['B', '/elsewhere/A']]);

    expect(await foldersRefused('/instance', folders, ['A'])).toEqual([
      { item: 'A', reason: "was skipped: its folder '/elsewhere/A' is outside the instance folder; its folder is also built by 'B'." },
    ]);
  });

  it('answers only the manifests asked, though it compares them with every manifest', async () => {
    const folders = new Map([['A', '/instance/mods/A'], ['B', '/instance/mods/A'], ['C', '/instance/mods/C']]);

    expect(await foldersRefused('/instance', folders, ['B', 'C'])).toEqual([
      { item: 'B', reason: "was skipped: its folder is also built by 'A'." },
    ]);
  });

  it('leaves a folder inside another to the search for manifests', async () => {
    const folders = new Map([['A', '/instance/mods/A'], ['B', '/instance/mods/A/B']]);

    expect(await foldersRefused('/instance', folders, ['A', 'B'])).toEqual([]);
  });

  it('resolves the instance folder and each folder once, however many it compares', async () => {
    const resolved: string[] = [];
    const folders = new Map(Array.from({ length: 20 }, (_, at) => [`M${at}`, `/instance/mods/M${at}`] as const));

    await foldersRefused('/instance', folders, [...folders.keys()], (path) => { resolved.push(path); return Promise.resolve(path); });

    expect(resolved.sort()).toEqual(['/instance', ...folders.values()].sort());
  });

  it('refuses a folder beside the instance folder whose name starts as the instance folder\'s does', async () => {
    expect(await foldersRefused('/instance', new Map([['A', '/instance-two/A']]), ['A'])).toEqual([
      { item: 'A', reason: "was skipped: its folder '/instance-two/A' is outside the instance folder." },
    ]);
  });
});
