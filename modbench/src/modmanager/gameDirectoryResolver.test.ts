import { describe, it, expect } from 'vitest';
import { createGameDirectoryResolver, dataFolderFrom, type ConfigChangeEvent, type GameDirectoryResolver } from './gameDirectoryResolver';
import type { GameDirectory } from './gameDirectory';

/** A minimal stand-in for vscode's WorkspaceConfiguration, same shape gameDirectory.test.ts uses. */
function fakeConfig(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

const noDetect = () => Promise.resolve(null);
const noDetectPrefix = () => Promise.resolve(null);

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
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, noDetectPrefix, fakeOnConfigChange().subscribe);

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
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, noDetectPrefix, onConfigChange.subscribe);

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
    const resolver = createGameDirectoryResolver('/instance', config, noDetect, noDetectPrefix, onConfigChange.subscribe);

    await resolver.resolve();
    onConfigChange.fire('modbench.mods.deploymentMode');
    await resolver.resolve();

    expect(calls).toBe(1);
  });

  it('resolves to the same GameDirectory the underlying resolveGameDirectory would produce', async () => {
    const detected: GameDirectory = { root: '/game', dataFolder: '/game/Data' };
    const detect = () => Promise.resolve({ dataFolder: detected.dataFolder, pluginsTxt: 'ignored' });
    const resolver = createGameDirectoryResolver('/instance', () => fakeConfig({}), detect, noDetectPrefix, fakeOnConfigChange().subscribe);

    expect(await resolver.resolve()).toEqual(detected);
  });
});

/** `dataFolderFrom` degrades a resolver's failure to `undefined` for views — this suite
 *  pins that the fold's log side effect happens once per *resolver generation*, not once
 *  per read, even though `ImplicitMasterDecorationProvider` reads it once per visible file. */
describe('dataFolderFrom', () => {
  /** A resolver double whose `resolve()` returns whatever `current` currently points at — set to
   *  a new rejected promise between calls to simulate the resolver moving to a new generation
   *  (a config change), and left alone to simulate the resolver still serving its cached one. */
  function fakeResolver(initial: Promise<GameDirectory | null>): GameDirectoryResolver & { setCurrent(p: Promise<GameDirectory | null>): void } {
    let current = initial;
    return {
      resolve: () => current,
      dispose: () => {},
      setCurrent: (p) => { current = p; },
    };
  }
  const rejectedSilently = (message: string) => {
    const p = Promise.reject(new Error(message));
    p.catch(() => {}); // this is the fixture's own await, not the code under test's — keep the runner quiet
    return p;
  };

  it('logs once across repeated reads of the same stuck-rejecting resolution', async () => {
    const resolver = fakeResolver(rejectedSilently('no Data/ subfolder'));
    const errors: unknown[] = [];
    const dataFolder = dataFolderFrom(resolver, (e) => errors.push(e));

    await dataFolder();
    await dataFolder();
    await dataFolder();

    expect(errors).toHaveLength(1);
  });

  it('logs again once the resolver moves to a new generation', async () => {
    const resolver = fakeResolver(rejectedSilently('first'));
    const errors: unknown[] = [];
    const dataFolder = dataFolderFrom(resolver, (e) => errors.push(e));

    await dataFolder();
    resolver.setCurrent(rejectedSilently('second'));
    await dataFolder();

    expect(errors).toHaveLength(2);
  });

  it('folds a resolved GameDirectory to its dataFolder, without logging', async () => {
    const resolver = fakeResolver(Promise.resolve({ root: '/game', dataFolder: '/game/Data' }));
    const errors: unknown[] = [];

    expect(await dataFolderFrom(resolver, (e) => errors.push(e))()).toBe('/game/Data');
    expect(errors).toHaveLength(0);
  });

  it('folds a null resolution to undefined, without logging', async () => {
    const resolver = fakeResolver(Promise.resolve(null));
    const errors: unknown[] = [];

    expect(await dataFolderFrom(resolver, (e) => errors.push(e))()).toBeUndefined();
    expect(errors).toHaveLength(0);
  });
});
