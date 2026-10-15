import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AGENT_GESTURES } from '../agent/gestures';
import { catalogCommandIds, GESTURES_MARKDOWN } from './commandsCatalog';

const KEPT_FROM_THE_AGENT = ['modbench.profile.switch', 'modbench.instance.refresh'];
const GIVEN_TO_THE_AGENT = ['modbench.record.open'];

describe('the gestures the agent runs (agent.md, Test seam)', () => {
  const specified = [...catalogCommandIds(GESTURES_MARKDOWN, 'writes'), ...GIVEN_TO_THE_AGENT].filter((id) => !KEPT_FROM_THE_AGENT.includes(id));

  it('are the catalog\'s gestures whose effect is writes, less those agent.md keeps from it, plus those it gives', () => {
    expect([...AGENT_GESTURES.keys()].sort()).toEqual(specified.sort());
  });
});
