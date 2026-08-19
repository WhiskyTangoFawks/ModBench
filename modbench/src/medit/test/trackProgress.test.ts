import { describe, it, expect } from 'vitest';
import { trackProgressMessage } from '../trackProgress';
import type { TrackStatus } from '../ApiClient';

// #414 review F2 (AC4 "reports progress"): the text withPluginsViewProgress/say show over a
// mega-plugin's worst-case tens-of-seconds Track — must genuinely name the phase and counts, not
// stay a static, unchanging message.
describe('trackProgressMessage', () => {
  const status = (over: Partial<TrackStatus> = {}): TrackStatus =>
    ({ phase: 'Idle', recordsDone: 0, recordsTotal: 0, ...over });

  it('names the parsing phase and the record total once it is known', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Parsing', recordsTotal: 400 }));

    expect(message).toContain('parsing');
    expect(message).toContain('400');
  });

  it('says work is under way, not a bare zero, while the record total is not known yet', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Parsing', recordsTotal: 0 }));

    expect(message).not.toContain('0');
    expect(message).toContain('parsing');
  });

  it('names how many of how many records have been serialized so far', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Serializing', recordsDone: 50, recordsTotal: 400 }));

    expect(message).toContain('50 of 400');
  });

  it('says committing during the git phase', () => {
    const message = trackProgressMessage('ModA', status({ phase: 'Committing', recordsDone: 400, recordsTotal: 400 }));

    expect(message).toContain('committing');
  });

  it('names the mod being tracked in every phase', () => {
    for (const phase of ['Idle', 'Parsing', 'Serializing', 'Committing'] as const) {
      expect(trackProgressMessage('MyMod', status({ phase }))).toContain('MyMod');
    }
  });
});
