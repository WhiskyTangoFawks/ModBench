import { describe, it, expect } from 'vitest';
import { trackProgressMessage } from '../trackProgress';
import type { TrackStatus } from '../ApiClient';

// #414 review F2 (AC4 "reports progress"): the text withPluginsViewProgress/say show over a
// mega-plugin's worst-case tens-of-seconds Track — must genuinely name the phase and counts, not
// stay a static, unchanging message.
//
// #451 review: renamed from recordsDone/recordsTotal — Track's own #451 slice A rewrite
// serializes each plugin through the whole-mod door in one call, so the wire status counts
// plugins, not records, and these tests (and the fixture values below) follow that.
describe('trackProgressMessage', () => {
  const status = (over: Partial<TrackStatus> = {}): TrackStatus =>
    ({ phase: 'Idle', pluginsDone: 0, pluginsTotal: 0, ...over });

  it('names the parsing phase and the plugin total once it is known', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 3 }));

    expect(message).toContain('parsing');
    expect(message).toContain('3');
    expect(message).toContain('plugins');
  });

  it('uses the singular for exactly one plugin', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 1 }));

    expect(message).toContain('1 plugin');
    expect(message).not.toContain('1 plugins');
  });

  it('says work is under way, not a bare zero, while the plugin total is not known yet', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Parsing', pluginsTotal: 0 }));

    expect(message).not.toContain('0');
    expect(message).toContain('parsing');
  });

  it('names how many of how many plugins have been serialized so far', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Serializing', pluginsDone: 1, pluginsTotal: 3 }));

    expect(message).toContain('1 of 3 plugins');
  });

  it('says committing during the git phase', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Committing', pluginsDone: 3, pluginsTotal: 3 }));

    expect(message).toContain('committing');
  });

  it('names the mod being tracked in every phase', () => {
    for (const phase of ['Idle', 'Parsing', 'Serializing', 'Committing'] as const) {
      expect(trackProgressMessage('MyMod', status({ phase }))).toContain('MyMod');
    }
  });
});
