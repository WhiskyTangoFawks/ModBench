// The pinned Overwrite row is tinted by a decoration provider keyed on a path, and rendered with
// a resourceUri built from the value. Both come from one Instance, or the tint lands on nothing.
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, fakeUri, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';

const { registerFileDecorationProvider, registerCommand } = vi.hoisted(() => ({
  registerFileDecorationProvider: vi.fn((provider: unknown) => ({ dispose: vi.fn(), provider })),
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { registerFileDecorationProvider },
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
}));

import { ModListProvider, OverwriteNode } from '../ModListProvider';
import { registerOverwriteView } from '../modManagementCommands';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InstanceValue, InstanceView } from '../../instance/instance';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { expectInstanceOf } from '../../test/expectInstanceOf';
import { OverwriteDecorationProvider } from '../OverwriteDecorationProvider';

const ROOT = join('/my', 'mo2', 'instance');

// One landed generation over ROOT, its paths exactly as a recompute names them.
const value: InstanceValue = instanceValueFixture({
  overwriteFileCount: 2,
  paths: { overwriteDir: join(ROOT, 'overwrite'), downloadsDir: join(ROOT, 'downloads'), modDirs: new Map() },
});

const instance: InstanceView = {
  value,
  sequence: 1,
  readFailure: undefined,
  subscribe: () => ({ dispose: () => {} }),
  onReadFailure: () => ({ dispose: () => {} }),
};

async function overwriteRow(): Promise<OverwriteNode> {
  const provider = new ModListProvider({ instance, instanceRoot: ROOT });
  const roots = await provider.getChildren();
  return expectInstanceOf(present(roots.find((n) => n instanceof OverwriteNode), 'the pinned Overwrite row'), OverwriteNode);
}

function registeredDecorator(): OverwriteDecorationProvider {
  registerFileDecorationProvider.mockClear();
  registerOverwriteView(instance, recordingReporter());
  const call = present(registerFileDecorationProvider.mock.calls[0], 'the registered decoration provider');
  return expectInstanceOf(call[0], OverwriteDecorationProvider);
}

describe('the Overwrite row’s tint reaches the row the tree renders', () => {
  it('tints the resourceUri the pinned row actually carries', async () => {
    const row = await overwriteRow();

    expect(registeredDecorator().provideFileDecoration(row.resourceUri)).toBeDefined();
  });

  // Rival: the provider keyed on the instance root instead of the value's overwrite path. Both
  // are strings, so only this composition tells them apart.
  it('leaves the instance root itself undecorated, so a root-keyed provider cannot pass', () => {
    expect(registeredDecorator().provideFileDecoration(fakeUri(ROOT))).toBeUndefined();
  });
});
