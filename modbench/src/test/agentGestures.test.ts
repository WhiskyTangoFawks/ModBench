import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AGENT_GESTURES } from '../agent/gestures';
import { catalogCommandIds, GESTURES_MARKDOWN } from './commandsCatalog';

const KEPT_FROM_THE_AGENT = ['modbench.profile.switch', 'modbench.instance.refresh'];
const GIVEN_TO_THE_AGENT = ['modbench.record.open'];
const AGENT_AHEAD_OF_CODE = [
  'modbench.modlist.init', 'modbench.modlist.stage', 'modbench.modlist.discardChanges', 'modbench.modlist.clean',
  'modbench.mod.move', 'modbench.mod.uninstall', 'modbench.mod.createEmpty', 'modbench.mod.install', 'modbench.mod.decompileAndCommit',
  'modbench.mod.build', 'modbench.mod.excludeFile', 'modbench.mod.includeFile', 'modbench.mod.rename',
  'modbench.separator.add', 'modbench.separator.rename', 'modbench.separator.delete',
  'modbench.downloadedFile.exclude', 'modbench.downloadedFile.include', 'modbench.downloadedFile.delete',
  'modbench.record.open',
];

describe('the gestures the agent runs (agent.md, Test seam)', () => {
  const specified = [...catalogCommandIds(GESTURES_MARKDOWN, 'writes'), ...GIVEN_TO_THE_AGENT].filter((id) => !KEPT_FROM_THE_AGENT.includes(id));

  it('are the catalog\'s gestures whose effect is writes, less those agent.md keeps from it, plus those it gives, but those specified ahead of the code', () => {
    expect([...AGENT_GESTURES.keys()].sort()).toEqual(specified.filter((id) => !AGENT_AHEAD_OF_CODE.includes(id)).sort());
  });

  it('lists as ahead of the code only gestures the agent is specified to run and does not yet, so the list expires with the code', () => {
    expect(AGENT_AHEAD_OF_CODE.filter((id) => !specified.includes(id) || AGENT_GESTURES.has(id))).toEqual([]);
  });
});
