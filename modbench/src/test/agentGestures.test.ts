import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AGENT_GESTURES } from '../agent/gestures';
import type { GestureCommand } from '../ports/phrase';
import { catalogCommandIds, GESTURES_MARKDOWN, RETIRED_AHEAD_OF_CODE, SPECIFIED_AHEAD_OF_CODE } from './commandsCatalog';

const KEPT_FROM_THE_AGENT = ['modbench.instance.logIn'];
const GIVEN_TO_THE_AGENT = ['modbench.record.open'];

describe('the gestures the agent runs (agent.md, Gestures, story 1)', () => {
  const specified = [...catalogCommandIds(GESTURES_MARKDOWN, 'writes'), ...GIVEN_TO_THE_AGENT, ...RETIRED_AHEAD_OF_CODE].filter((id) => !KEPT_FROM_THE_AGENT.includes(id) && !SPECIFIED_AHEAD_OF_CODE.includes(id));

  it('are the catalog\'s gestures whose effect is writes and whose code exists, less those agent.md keeps from it, plus those it gives', () => {
    expect([...AGENT_GESTURES.keys()].sort()).toEqual(specified.sort());
  });
});

describe('the gestures a message names (agent.md, Reporting, story 4)', () => {
  const NAMED: Record<GestureCommand, true> = {
    'modbench.modlist.gitInit': true,
    'modbench.mod.updateManifest': true,
    'modbench.mod.build': true,
    'modbench.mod.versionInGit': true,
    'modbench.plugin.decompile': true,
    'modbench.plugin.decompileAndRepair': true,
  };

  it.each(Object.keys(NAMED))('has a tool, because %s is a gesture the agent runs', (command) => {
    expect(AGENT_GESTURES.has(command)).toBe(true);
  });
});
