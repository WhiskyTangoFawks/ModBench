import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOXES, DRIVING_BOXES } from './boxes';
import { SRC } from './scanSource';

async function configList(name: string): Promise<string[]> {
  const loaded: unknown = await import(pathToFileURL(join(SRC, '..', 'eslint.config.mjs')).href);
  const list: unknown = typeof loaded === 'object' && loaded !== null ? Object.entries(loaded).find(([key]) => key === name)?.[1] : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

describe('the lint config names the boxes the zoom-out draws', () => {
  it('every box', async () => {
    expect((await configList('BOXES')).sort()).toEqual([...BOXES].sort());
  });

  it('the driving boxes', async () => {
    expect((await configList('DRIVING_BOXES')).sort()).toEqual([...DRIVING_BOXES].sort());
  });
});
