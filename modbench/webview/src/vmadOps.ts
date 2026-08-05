// Pure VMAD helpers shared by vmadTreeAdapter.ts, VmadObjectCell.tsx, VmadPropertyOps.tsx
// (AddPropertyDialog), and RecordPanel.tsx's own structural-op commands.

// VMAD property types that can be added (everything except Variable / ArrayOfVariable).
export const ADDABLE_TYPES = [
  'Bool', 'Int', 'Float', 'String', 'Object',
  'ArrayOfBool', 'ArrayOfInt', 'ArrayOfFloat', 'ArrayOfString', 'ArrayOfObject',
  'Struct', 'ArrayOfStruct',
] as const;

export const SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;

export function defaultOpValue(type: string): unknown {
  switch (type) {
    case 'Bool': return false;
    case 'Int': case 'Float': return 0;
    case 'String': return '';
    case 'Object': return { formKey: '', alias: -1 };
    default: return []; // arrays / struct / structList start empty
  }
}

// Scalar editor kind for a VMAD type string, or null for non-scalar types.
export function opScalarKind(type: string): 'bool' | 'int' | 'float' | 'string' | null {
  if (type === 'Bool') return 'bool';
  if (type === 'Int') return 'int';
  if (type === 'Float') return 'float';
  if (type === 'String') return 'string';
  return null;
}

// VMAD\Script\Prop → { script, prop }; null for malformed / script-level paths.
export function parseVmadPath(path: string): { script: string; prop: string } | null {
  const parts = path.split('\\');
  if (parts.length < 3 || parts[0] !== 'VMAD') return null;
  return { script: parts[1], prop: parts.slice(2).join('\\') };
}
