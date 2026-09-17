/** VS Code's when-clause parser collapses `key == false` into `!key`, so an unset key and a
 *  false one are indistinguishable; the always-`true` second key exists only to be unset
 *  before the check has run. */
export function mo2InstanceContext(isInstance: boolean): Record<string, boolean> {
  return {
    'modbench.workspaceIsMo2Instance': isInstance,
    'modbench.workspaceMo2CheckDone': true,
  };
}
