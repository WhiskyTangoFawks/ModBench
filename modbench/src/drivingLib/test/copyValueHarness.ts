import { vi } from 'vitest';
import type { CopyValueAdapter } from '../copyValue';
import type { Reporter } from '../../ports/reporter';

const registerCommand = vi.fn((_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn() }));
export const writeText = vi.fn<(value: string) => unknown>();

/** The `vscode` members copy value calls, for a test's `vi.mock('vscode', ...)` to spread in. This
 *  module loads nothing that imports `vscode`, so the hoisted mock can read it. */
export const setStatusBarMessage = vi.fn<(message: string, hideAfterMs: number) => unknown>();
export const copyValueVscode = { commands: { registerCommand }, env: { clipboard: { writeText } }, window: { setStatusBarMessage } };

export function invokeCommand(...args: unknown[]): Promise<unknown> {
  const call = registerCommand.mock.calls.find((c) => c[0] === 'modbench.copyValue');
  if (!call) throw new Error('modbench.copyValue was not registered');
  return Promise.resolve(call[1](...args));
}

export async function register(
  adapters: readonly CopyValueAdapter[], reporterFor: (tag: string) => Reporter, focusedViewId?: string,
): Promise<void> {
  const { registerCopyValueCommand } = await import('../copyValue');
  registerCopyValueCommand(adapters, reporterFor, () => focusedViewId);
}
