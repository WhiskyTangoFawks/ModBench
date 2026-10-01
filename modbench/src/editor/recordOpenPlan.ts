import type { RecordAddress } from './recordUri';

export interface RecordOpenPlan {
  addresses: RecordAddress[];
  beside: boolean;
  /** Only a lone record opened in place is a preview, which the next click replaces. */
  preview: boolean;
}

// A tree row states its record structurally, so a test can use literals shaped like the nodes.
function addressOf(node: unknown): RecordAddress | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { kind?: string; record?: { formKey?: string }; formKey?: string; origin?: string };
  const formKey = n.kind === 'record' ? n.record?.formKey : n.formKey;
  if (!formKey) return undefined;
  return n.kind === undefined && n.origin !== undefined ? { formKey, origin: n.origin } : { formKey };
}

function asksBeside(argument: unknown): boolean {
  return typeof argument === 'object' && argument !== null && 'placement' in argument && argument.placement === 'beside';
}

/** A menu hands over the clicked row and the selection, which opens beside. A palette entry or key
 *  hands over no Argument, so it takes the focused view's selection (commands.md, Principles). */
export function recordOpenPlan(argument: unknown, selection: unknown, focusedSelection: readonly unknown[]): RecordOpenPlan {
  const fromMenu = Array.isArray(selection);
  const subjects: readonly unknown[] = fromMenu ? (selection.length > 0 ? selection : [argument])
    : argument === undefined ? focusedSelection
    : Array.isArray(argument) ? argument : [argument];
  const addresses = subjects.flatMap((s) => addressOf(s) ?? []);
  const beside = fromMenu || asksBeside(argument);
  return { addresses, beside, preview: !beside && addresses.length === 1 };
}
