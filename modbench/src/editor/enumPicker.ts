import type { EnumChoice } from '../wire/messages';
import { pickWithMarked } from '../drivingLib/pickWithMarked';

interface EnumItem { label: string; value: string }

/** Native QuickPick of an enum's names, opened on the current value (xedit.md, divergence 1). */
export async function pickEnumValue(choices: readonly EnumChoice[], current: string): Promise<string | null> {
  const items: EnumItem[] = choices.map(({ value, label }) => ({ label, value }));
  const picked = await pickWithMarked(items, items.find(i => i.value === current), 'Select a value');
  return picked?.value ?? null;
}
