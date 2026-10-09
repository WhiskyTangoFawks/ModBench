import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, Uri: { from: uriFrom },
  };
});

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPluginEnableCommands } from '../pluginParticipationCommands';
import { PluginNode, ImplicitMasterNode } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { pluginsCommandsOver } from '../../test/mo2/adapterOver';
import { progressSteps } from '../../test/recordedProgress';

const LONG_AGO = new Date('2020-01-01T00:00:00Z');
const INITIAL = 'Alpha.esp\r\n*Beta.esp\r\n';

let dir: string;
const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
const bytes = () => readFile(pluginsTxt(), 'utf8');
const mtime = async () => (await stat(pluginsTxt())).mtimeMs;

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const handler = present(handlers.get(commandId), `command not registered: ${commandId}`);
  return Promise.resolve(handler(...args));
}

beforeEach(async () => {
  handlers.clear();
  progressSteps.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'plugin-participation-'));
  await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
  await writeFile(pluginsTxt(), INITIAL);
  await utimes(pluginsTxt(), LONG_AGO, LONG_AGO);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const instance = () => ({
  value: instanceValueFixture({ activeProfile: 'Default' }),
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
});

function registered(viewSelection: () => PluginNode[] = () => []) {
  const reporter = recordingReporter();
  registerPluginEnableCommands(pluginsCommandsOver(dir), instance(), viewSelection, reporter);
  return reporter;
}

describe('modbench.plugin.enable / modbench.plugin.disable: the whole selection, one command per direction', () => {
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');
  const beta = new PluginNode({ name: 'Beta.esp', enabled: true }, 'SomeMod');
  const locked = new ImplicitMasterNode('Fallout4.esm', 'Data/');

  it('enable applies to every selected plugin, whatever its own current state', async () => {
    registered();
    await invoke('modbench.plugin.enable', alpha, [alpha, beta]);

    expect(await bytes()).toBe('*Alpha.esp\r\n*Beta.esp\r\n');
  });

  it('disable applies to every selected plugin, whatever its own current state', async () => {
    registered();
    await invoke('modbench.plugin.disable', beta, [alpha, beta]);

    expect(await bytes()).toBe('Alpha.esp\r\nBeta.esp\r\n');
  });

  it('a right-click outside the selection takes just that row, not the rest of the view selection', async () => {
    registered(() => [alpha]);
    await invoke('modbench.plugin.disable', beta, undefined);

    expect(await bytes()).toBe('Alpha.esp\r\nBeta.esp\r\n');
  });

  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    registered(() => [alpha]);
    await invoke('modbench.plugin.enable');

    expect(await bytes()).toBe('*Alpha.esp\r\n*Beta.esp\r\n');
  });

  it('drops a locked row from the selection it writes', async () => {
    const reporter = registered();
    await invoke('modbench.plugin.enable', alpha, [locked, alpha]);

    expect(await bytes()).toBe('*Alpha.esp\r\n*Beta.esp\r\n');
    expect(reporter.reports).toEqual([]);
  });

  it('writes nothing and reports nothing for an empty selection', async () => {
    const reporter = registered();
    await invoke('modbench.plugin.enable');

    expect(await mtime()).toBe(LONG_AGO.getTime());
    expect(progressSteps).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('says nothing when the whole selection lands', async () => {
    const reporter = registered();
    await invoke('modbench.plugin.enable', alpha);

    expect(reporter.reports).toEqual([]);
  });

  it('reports a gone plugin by name, once, while the rest land', async () => {
    const reporter = registered();
    await invoke('modbench.plugin.enable', alpha, [alpha, new PluginNode({ name: 'Gone.esp', enabled: true }, 'SomeMod')]);

    expect(await bytes()).toBe('*Alpha.esp\r\n*Beta.esp\r\n');
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not enable 1 of 2 plugins.', detail: '"Gone.esp" (Plugin not found in plugins.txt: Gone.esp)' },
    ]);
  });

  it('reports the whole selection refused, once, when plugins.txt cannot be written', async () => {
    await rm(pluginsTxt());
    const reporter = registered();

    await invoke('modbench.plugin.disable', alpha);

    expect(reporter.reports).toMatchObject([{ severity: 'error', message: 'Failed to disable plugins.' }]);
  });
});

describe('the enable and disable entries end when the read lands (common.md, A gesture that writes)', () => {
  const alpha = new PluginNode({ name: 'Alpha.esp', enabled: false }, 'SomeMod');

  it('shows the progress bar from the key until the read after the write lands', async () => {
    registered();
    await invoke('modbench.plugin.enable', alpha);

    expect(await bytes()).toBe('*Alpha.esp\r\n*Beta.esp\r\n');
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('still ends on the read when the whole write is refused', async () => {
    await rm(pluginsTxt());
    registered();

    await invoke('modbench.plugin.enable', alpha);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });
});
