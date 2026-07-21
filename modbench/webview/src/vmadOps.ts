// Pure types/helpers shared by the VMAD section coordinator and its structural-op leaf
// components (VmadPropertyOps, VmadScriptOps). Split out so those leaves don't import back
// into VmadSection.tsx (which imports them), and so they stay easy to test without React.

// A VMAD structural operation payload (phase 13.8). The `op` discriminator routes the change.
export interface StructOp {
  op: string;
  [k: string]: unknown;
}

export type OnStructOp = (plugin: string, vmadPath: string, op: StructOp) => void;

// VMAD property types that can be added (everything except Variable / ArrayOfVariable).
export const ADDABLE_TYPES = [
  'Bool', 'Int', 'Float', 'String', 'Object',
  'ArrayOfBool', 'ArrayOfInt', 'ArrayOfFloat', 'ArrayOfString', 'ArrayOfObject',
  'Struct', 'ArrayOfStruct',
] as const;

export const SCRIPT_FLAGS = ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved'] as const;

export const PROP_FLAGS = ['Edited', 'Removed'] as const;

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

export function isStructOp(v: unknown): v is StructOp {
  return typeof v === 'object' && v !== null && typeof (v as { op?: unknown }).op === 'string';
}

// VMAD\Script\Prop → { script, prop }; null for malformed / script-level paths.
export function parseVmadPath(path: string): { script: string; prop: string } | null {
  const parts = path.split('\\');
  if (parts.length < 3 || parts[0] !== 'VMAD') return null;
  return { script: parts[1], prop: parts.slice(2).join('\\') };
}

// VMAD\<ScriptName> (no property segment) → script name; null otherwise.
export function parseVmadScriptPath(path: string): string | null {
  const parts = path.split('\\');
  return parts.length === 2 && parts[0] === 'VMAD' ? parts[1] : null;
}
