import { describe, it, expect, vi } from 'vitest';
import { resolveOrigin } from '../resolveOrigin';
import { InMemoryMEditClient, type PluginMetadata } from '../../client';

function makePlugins(count: number): PluginMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Plugin${i}.esp`,
    path: `/data/Plugin${i}.esp`,
    loadOrderIndex: i,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 10,
    isImmutable: false,
    enabled: true, winning: true, participates: true, inLoadOrder: true,
    origin: 'Data',
    masterIssues: [],
    hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
  }));
}

describe('resolveOrigin', () => {
  it('finds the loaded origin for a plugin name', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', makePlugins(2));

    const origin = await resolveOrigin(client, 'Plugin1.esp', vi.fn());

    expect(origin).toBe('Data');
  });

  it('answers undefined for a name the load order has not loaded', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', makePlugins(2));

    const origin = await resolveOrigin(client, 'NotLoaded.esp', vi.fn());

    expect(origin).toBeUndefined();
  });

  // Before Launch mEdit no backend answers GET /plugins, so the call rejects. Uncaught, that
  // surfaces as VS Code's own raw "Error running command … fetch failed" toast.
  it('degrades to undefined — not a thrown rejection — when the backend itself is unreachable', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryFailure('getPlugins', new Error('fetch failed'));
    const log = vi.fn();

    const origin = await resolveOrigin(client, 'Plugin1.esp', log);

    expect(origin).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('resolveOrigin'));
  });
});
