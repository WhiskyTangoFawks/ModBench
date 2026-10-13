import { describe, it, expect } from 'vitest';
import { decompileAndCommitProgressMessage } from '../decompileAndCommitProgress';
import type { InitStatus } from '../../client';

describe('decompileAndCommitProgressMessage', () => {
  const status = (over: Partial<InitStatus> = {}): InitStatus =>
    ({ phase: 'Idle', pluginsDone: 0, pluginsTotal: 0, ...over });

  it('names the parsing phase and the plugin total once it is known', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 3 }));

    expect(message).toContain('parsing');
    expect(message).toContain('3');
    expect(message).toContain('plugins');
  });

  it('uses the singular for exactly one plugin', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 1 }));

    expect(message).toContain('1 plugin');
    expect(message).not.toContain('1 plugins');
  });

  it('says work is under way, not a bare zero, while the plugin total is not known yet', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 0 }));

    expect(message).not.toContain('0');
    expect(message).toContain('parsing');
  });

  it('names how many of how many plugins have been serialized so far', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'Serializing', pluginsDone: 1, pluginsTotal: 3 }));

    expect(message).toContain('1 of 3 plugins');
  });

  it('says reading its installation files while the Instance adapter reads them, before mEdit is asked', () => {
    const message = decompileAndCommitProgressMessage('ModA', { mod: 'ModA', phase: 'ReadingInstallationFiles' });

    expect(message).toBe('Decompiling and committing "ModA" — reading its installation files…');
  });

  it('says reading its files while it tells the assets from what the installation files yield', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'ReadingFiles', pluginsDone: 3, pluginsTotal: 3 }));

    expect(message).toContain('reading its files');
  });

  it('says committing during the git phase', () => {
    const message = decompileAndCommitProgressMessage('ModA', status({ phase: 'Committing', pluginsDone: 3, pluginsTotal: 3 }));

    expect(message).toContain('committing');
  });

  it('names the mod being initialized in every phase', () => {
    for (const phase of ['Idle', 'Parsing', 'Serializing', 'ReadingFiles', 'Committing'] as const) {
      expect(decompileAndCommitProgressMessage('MyMod', status({ phase }))).toContain('MyMod');
    }
  });
});
