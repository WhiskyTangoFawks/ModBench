import { describe, it, expect } from 'vitest';
import { mo2InstanceContext } from '../mo2InstanceContext';

// An unset context key reads identically to `false` under a plain `!key` negation, so a second
// key is what tells "checked, and not an instance" apart from "never checked".
describe('mo2InstanceContext', () => {
  it('always marks the check done, whether the workspace is an instance or not', () => {
    expect(mo2InstanceContext(true)['modbench.workspaceMo2CheckDone']).toBe(true);
    expect(mo2InstanceContext(false)['modbench.workspaceMo2CheckDone']).toBe(true);
  });

  it('carries the instance verdict through workspaceIsMo2Instance unchanged', () => {
    expect(mo2InstanceContext(true)['modbench.workspaceIsMo2Instance']).toBe(true);
    expect(mo2InstanceContext(false)['modbench.workspaceIsMo2Instance']).toBe(false);
  });
});
