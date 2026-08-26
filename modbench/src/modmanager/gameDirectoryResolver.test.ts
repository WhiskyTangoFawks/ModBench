import { describe, it, expect } from 'vitest';
import { createGameDirectoryResolver, type ConfigChangeEvent } from './gameDirectoryResolver';
import type { GameDirectory } from './gameDirectory';

/** A minimal stand-in for vscode's WorkspaceConfiguration, same shape gameDirectory.test.ts uses. */
function fakeConfig(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

const noDetect = () => Promise.resolve(null);

/** Captures the listener `onConfigChange` was given so a test can fire it directly, the same way
 *  `vscode.workspace.onDidChangeConfiguration`'s single-listener-arg overload would be driven. */
function fakeOnConfigChange() {
  let listener: ((e: ConfigChangeEvent) => void) | undefined;
  return {
    subscribe: (l: (e: ConfigChangeEvent) => void) => {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
    fire: (section: string) => listener?.({ affectsConfiguration: (s) => s === section }),
  };
}

describe('createGameDirectoryResolver', () => {
  it('memoises: two resolve() calls with an unchanged setting only resolve once', async () => {
    let calls = 0;
    const config = () => {
      calls++;
      return fakeConfig({});
    };
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, fakeOnConfigChange().subscribe);

    await resolver.resolve();
    await resolver.resolve();

    expect(calls).toBe(1);
  });

  it('re-resolves after a config change affecting modbench.mods.gameDirectory', async () => {
    let calls = 0;
    const config = () => {
      calls++;
      return fakeConfig({});
    };
    const onConfigChange = fakeOnConfigChange();
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, onConfigChange.subscribe);

    await resolver.resolve();
    onConfigChange.fire('modbench.mods.gameDirectory');
    await resolver.resolve();

    expect(calls).toBe(2);
  });

  it('does not invalidate the cache for a change affecting an unrelated setting', async () => {
    let calls = 0;
    const config = () => {
      calls++;
      return fakeConfig({});
    };
    const onConfigChange = fakeOnConfigChange();
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, onConfigChange.subscribe);

    await resolver.resolve();
    onConfigChange.fire('modbench.mods.deploymentMode');
    await resolver.resolve();

    expect(calls).toBe(1);
  });

  it('resolves to the same GameDirectory the underlying resolveGameDirectory would produce', async () => {
    const detected: GameDirectory = { root: '/game', dataFolder: '/game/Data' };
    const detect = () => Promise.resolve({ dataFolder: detected.dataFolder, pluginsTxt: 'ignored' });
    const resolver = createGameDirectoryResolver('/instance', () => fakeConfig({}), detect, fakeOnConfigChange().subscribe);

    expect(await resolver.resolve()).toEqual(detected);
  });
});
