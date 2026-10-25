import { describe, it, expect } from 'vitest';
import { unreadableSources } from '../unreadableSource';

describe('unreadableSources', () => {
  it('names each plugin whose source is unreadable by its column, with why and whether decompile repairs it', () => {
    const gone = { reason: 'Gone.', decompileRepairs: true };
    const malformed = { reason: 'Malformed.', decompileRepairs: false };

    const map = unreadableSources([
      { name: 'A.esp', origin: 'ModA', pluginSourceUnreadable: gone },
      { name: 'A.esp', origin: 'ModB', pluginSourceUnreadable: null },
      { name: 'B.esp', origin: 'Data/', pluginSourceUnreadable: malformed },
      { name: 'C.esp', origin: 'ModA' },
    ]);

    expect([...map]).toEqual([['A.esp|ModA', gone], ['B.esp', malformed]]);
  });
});
