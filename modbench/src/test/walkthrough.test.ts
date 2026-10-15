import { describe, it, expect } from 'vitest';
import { openWalkthroughOnce } from '../walkthrough';

function fakeGlobalState() {
  const held = new Map<string, unknown>();
  return {
    get: (key: string): unknown => held.get(key),
    update: (key: string, value: unknown) => { held.set(key, value); return Promise.resolve(); },
  };
}

describe('openWalkthroughOnce (common.md, Getting started, story 2)', () => {
  it('opens the walkthrough the first time Modbench activates, and never on a later activation', async () => {
    const state = fakeGlobalState();
    const opened: string[] = [];
    const open = (walkthrough: string) => { opened.push(walkthrough); return Promise.resolve(); };

    await openWalkthroughOnce(state, 'whiskytangofawks.modbench', open);
    await openWalkthroughOnce(state, 'whiskytangofawks.modbench', open);

    expect(opened).toEqual(['whiskytangofawks.modbench#gettingStarted']);
  });
});
