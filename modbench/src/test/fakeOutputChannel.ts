import { vi } from 'vitest';
import type * as vscode from 'vscode';

/** A full `vscode.LogOutputChannel` (ADR-0002-adjacent test seam): every write lands on a
 *  `vi.fn()`, so a test asserts on calls instead of parsing rendered text. */
export class FakeLogOutputChannel implements vscode.LogOutputChannel {
  readonly name = 'fake';
  readonly logLevel: vscode.LogLevel = 1;
  readonly onDidChangeLogLevel = (): vscode.Disposable => ({ dispose: () => { /* no-op */ } });
  readonly trace = vi.fn();
  readonly debug = vi.fn();
  readonly info = vi.fn();
  readonly warn = vi.fn();
  readonly error = vi.fn();
  readonly append = vi.fn();
  readonly appendLine = vi.fn();
  readonly replace = vi.fn();
  readonly clear = vi.fn();
  readonly show = vi.fn();
  readonly hide = vi.fn();
  readonly dispose = vi.fn();
}
