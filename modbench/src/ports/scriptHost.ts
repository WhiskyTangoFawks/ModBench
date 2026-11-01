/** Where a Modbench script runs from: the interpreter the Python extension selects for the window, and the path of a default script Modbench ships. */
export interface ScriptHost {
  readonly interpreter: () => Promise<string | undefined>;
  /** The path of the shipped default script of this name, none when Modbench ships no such script. */
  readonly defaultScript: (name: string) => Promise<string | undefined>;
}
