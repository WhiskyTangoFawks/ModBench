// The boxes the zoom-out draws, each with the reference list target-architecture-references.d2
// draws for it.

export const KERNEL_BOXES = ['loadOrderFileCodec', 'tables', 'wire', 'ports'];

// The driven column: the arrows that leave the box, plus its column's kernel by the band's rule.
export const DRIVEN_BOXES: Record<string, string[]> = {
  instanceAdapter: ['loadOrderFileCodec', 'ports', 'tables'],
  instanceLoader: ['instanceAdapter', 'ports', 'tables'],
};

// The core column, same rule. An arrow the diagram draws that the code has no use for is left
// out here and reported, never referenced to make the picture symmetric.
export const CORE_BOXES: Record<string, string[]> = {
  modlist: ['instanceAdapter', 'ports'],
  pluginsCommands: ['instanceLoader', 'loadOrderFileCodec', 'instanceAdapter', 'ports'],
  instanceCommands: ['client', 'instanceLoader', 'instanceAdapter', 'ports', 'tables'],
  downloadsCommands: ['instanceAdapter', 'ports'],
  install: ['instanceAdapter', 'ports'],
  client: ['ports', 'wire'],
};

// The driving band: the views, and the driving lib they share (ADR-0014). No Toolbox file uses
// its drawn deploy commands or tables, so both are left out.
export const DRIVING_BOXES: Record<string, string[]> = {
  toolbox: ['instanceCommands', 'instanceLoader', 'ports'],
  mods: ['drivingLib', 'install', 'instanceLoader', 'modlist', 'ports'],
  downloads: ['downloadsCommands', 'drivingLib', 'install', 'instanceLoader', 'ports'],
  plugins: ['client', 'drivingLib', 'instanceLoader', 'pluginsCommands', 'ports'],
  editor: ['client', 'ports', 'wire'],
  drivingLib: ['instanceLoader'],
};

export const REFERENCING_BOXES: Record<string, string[]> = { ...DRIVEN_BOXES, ...CORE_BOXES, ...DRIVING_BOXES };
