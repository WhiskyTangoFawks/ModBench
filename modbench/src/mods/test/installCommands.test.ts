import { FOMOD_PAGE, VIEW_ANSWER } from '../../test/fomodDialogDouble';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri } from '../../test/vscodeMock';

const { registerCommand, executeCommand, showOpenDialog, showInputBox, showQuickPick, openExternal } = vi.hoisted(() => ({
  registerCommand: vi.fn((_id: string, handler: (...args: unknown[]) => unknown) => ({ dispose: vi.fn(), handler })),
  executeCommand: vi.fn((_command: string, _uri?: { fsPath: string }) => Promise.resolve()),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn<(options?: vscode.InputBoxOptions) => Promise<string | undefined>>(),
  showQuickPick: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showOpenDialog, showInputBox, showQuickPick, withProgress: recordedWithProgress },
    env: { openExternal },
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
    Uri: { ...Uri, parse: (s: string) => ({ toString: () => s }) },
  };
});

import { registerModInstallCommands } from '../installCommands';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { modCommands } from '../../modCommands/modCommands';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import {
  downloadedFilesOf, fakeInstanceAdapter, modFoldersIn, modFoldersOf, readingFixture, refusing, type FakeInstanceAdapter, type InstanceAnswers,
} from '../../test/fakeInstanceAdapter';
import { present } from '../../ports/present';
import { recordingReporter, type RecordingReporter } from '../../test/surfacingDoubles';
import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { manifestedIn } from '../../test/modStatusFixture';

function invoke(commandId: string, ...args: unknown[]): Promise<unknown> {
  const [, handler] = present(registerCommand.mock.calls.find((c) => c[0] === commandId), `the ${commandId} handler`);
  return Promise.resolve(handler(...args));
}


let fake: FakeInstanceAdapter;

type ModInstallDeps = Parameters<typeof registerModInstallCommands>[0];

function register(
  over: Partial<ModInstallDeps> = {}, answers: InstanceAnswers = {}, modFolders = modFoldersOf('Harder VATS'),
): void {
  fake = fakeInstanceAdapter(readingFixture({ modFolders, downloadedFiles: downloadedFilesOf('foo.7z') }), answers);
  registerModInstallCommands({
    commands: modCommands(fake.adapter),
    instance: { value: instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('foo.7z')] } }), refresh: () => Promise.resolve() },
    reporterFor: () => recordingReporter(),
    ask: vi.fn(),
    fomodDialog: () => FOMOD_PAGE,
    downloadedFileInstallReporting: { reporter: recordingReporter(), log: vi.fn(), progressViewId: 'modbench.downloads' },
    ...over,
  });
}

const installs = () => fake.calls.flatMap((call) => (call.verb === 'install' ? [{ package: call.package, target: call.target, fomod: call.fomod }] : []));

const reportingTo = (reporter: RecordingReporter): Partial<ModInstallDeps> =>
  ({ reporterFor: () => reporter, downloadedFileInstallReporting: { reporter, log: vi.fn(), progressViewId: 'modbench.downloads' } });

const NEW_MOD = { kind: 'new', name: 'New Mod' } as const;

const stepOnInstall: InstanceAnswers['refusals'] = (call) => {
  if (call.verb === 'install') progressSteps.push('install');
  return undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  showQuickPick.mockReset();
  showOpenDialog.mockReset();
  showInputBox.mockReset();
});

describe('modbench.mod.install: installation file or folder, asked first', () => {
  it.each<[string, unknown, unknown, string | undefined]>([
    ['Esc at the installation-file-or-folder pick', undefined, undefined, undefined],
    ['Esc at the OS picker for an installation file', { packageKind: 'archive' }, undefined, undefined],
    ['Esc at the OS picker for a folder', { packageKind: 'folder' }, undefined, undefined],
    ['a cancelled name prompt', { packageKind: 'archive' }, [Uri.file('/archive/foo.7z')], undefined],
  ])('%s installs nothing', async (_case, pick, picked, name) => {
    showQuickPick.mockResolvedValueOnce(pick);
    showOpenDialog.mockResolvedValueOnce(picked);
    showInputBox.mockResolvedValueOnce(name);

    register();
    await invoke('modbench.mod.install');

    expect(fake.calls).toEqual([]);
  });

  it('asks installation file or folder before either OS picker opens', async () => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce(undefined);

    register();
    await invoke('modbench.mod.install');

    expect(showQuickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ packageKind: 'archive' }), expect.objectContaining({ packageKind: 'folder' })],
      expect.anything(),
    );
    const quickPickOrder = present(showQuickPick.mock.invocationCallOrder[0], 'the showQuickPick call order');
    const openDialogOrder = present(showOpenDialog.mock.invocationCallOrder[0], 'the showOpenDialog call order');
    expect(quickPickOrder).toBeLessThan(openDialogOrder);
  });

  it.each([
    ['installation file', 'archive', '/archive/foo.7z', { filters: { 'Mod archives': ['zip', '7z', 'rar'] } }],
    ['folder', 'folder', '/somewhere/Loose Files', { canSelectFiles: false, canSelectFolders: true, canSelectMany: false }],
  ] as const)('%s: the OS picker offers what install takes, and installs the pick as a new mod under the name prompted', async (_case, packageKind, path, dialog) => {
    showQuickPick.mockResolvedValueOnce({ packageKind });
    showOpenDialog.mockResolvedValueOnce([Uri.file(path)]);
    showInputBox.mockResolvedValueOnce('New Mod');

    register();
    await invoke('modbench.mod.install');

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining(dialog));
    expect(installs()).toEqual([{ package: { kind: packageKind, path }, target: NEW_MOD, fomod: VIEW_ANSWER }]);
  });
});

describe('modbench.mod.install: the name prompt', () => {
  it.each([
    ['archive', '/archive/Sleep or Save-123-1-0.7z', 'Sleep or Save-123-1-0'],
    ['archive', 'C:\\archive\\Sleep or Save.ZIP', 'Sleep or Save'],
    ['archive', '/archive/Mod v1.2.rar', 'Mod v1.2'],
    ['archive', '/archive/notes.txt', 'notes'],
    ['folder', '/somewhere/Loose Files', 'Loose Files'],
    ['folder', 'C:\\somewhere\\Loose v1.2', 'Loose v1.2'],
  ] as const)('%s picked at %s: the prompt holds %s', async (packageKind, picked, name) => {
    showQuickPick.mockResolvedValueOnce({ packageKind });
    showOpenDialog.mockResolvedValueOnce([Uri.file(picked)]);
    showInputBox.mockResolvedValueOnce(undefined);

    register();
    await invoke('modbench.mod.install');

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: name }));
  });
});

describe('modbench.mod.install from the view: what reaches the user', () => {
  beforeEach(() => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'folder' });
    showOpenDialog.mockResolvedValueOnce([Uri.file('/somewhere/foo')]);
    showInputBox.mockResolvedValueOnce('New Mod');
  });

  it('reports nothing for an install the user cancelled on the FOMOD installer\'s page', async () => {
    const reporter = recordingReporter();

    register(reportingTo(reporter), { installed: { landed: false, cancelled: true } });
    await invoke('modbench.mod.install');

    expect(reporter.reports).toEqual([]);
  });

  it('warns of what a FOMOD installed from the page said, and not of the missing files the user confirmed', async () => {
    const reporter = recordingReporter();

    register(reportingTo(reporter), { installed: { landed: true, fomod: { kind: 'installer', missing: ['gone.esp'], notes: ['Installer failed'] } } });
    await invoke('modbench.mod.install');

    expect(reporter.reports).toEqual([{ severity: 'warning', message: '"New Mod": its FOMOD\'s installer says', detail: 'Installer failed' }]);
  });
});

describe('modbench.mod.install: a failed install', () => {
  it.each([
    ['archive', Uri.file('/somewhere/foo.zip'), 'installFromInstallationFile'],
    ['folder', Uri.file('/somewhere/foo'), 'installFromFolder'],
  ] as const)('from a %s is reported under the gesture, naming the mod', async (packageKind, picked, tag) => {
    const reporter = recordingReporter();
    const tags: string[] = [];
    showQuickPick.mockResolvedValueOnce({ packageKind });
    showOpenDialog.mockResolvedValueOnce([picked]);
    showInputBox.mockResolvedValueOnce('New Mod');

    register({ reporterFor: (t) => { tags.push(t); return reporter; } }, { refusals: refusing('install', 'disk full') });
    await invoke('modbench.mod.install');

    expect(tags).toEqual([tag]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "New Mod".', detail: 'disk full' }]);
  });
});

describe('modbench.mod.install: a downloaded file is its package', () => {
  it('a mod row as Argument is no package, so it asks installation file or folder', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    register();
    await invoke('modbench.mod.install', { kind: 'mod', mod: { name: 'Some Mod' } });

    expect(showQuickPick).toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});

const NO_CHOICES = { kind: 'choices', steps: [] };

describe('modbench.mod.install called by the agent', () => {
  const outsideInstallationFile = { kind: 'archive' as const, path: '/elsewhere/bar.zip' };
  const install = (argument: AgentCall['argument'], options: object) => invoke('modbench.mod.install', new AgentCall(argument, options));
  const refusalOf = (argument: AgentCall['argument'], options: object) => install(argument, options).then(() => undefined, (error: unknown) => error);
  const nothingAsked = () => {
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
  };

  it('installs the downloaded file named as a new mod under the name given, asking nothing, and answers the mod written', async () => {
    const reporter = recordingReporter();

    register(reportingTo(reporter));
    const answered = await install([{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(installs()).toEqual([{ package: { kind: 'archive', path: '/downloads/foo.7z' }, target: { kind: 'new', name: 'Foo' }, fomod: NO_CHOICES }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Foo' }], refused: [] }, partial: [] });
    expect(reporter.reports).toEqual([]);
    nothingAsked();
  });

  it.each([
    ['an installation file outside the downloads as an installation file', outsideInstallationFile, 'Bar'],
    ['a folder as a folder', { kind: 'folder', path: '/elsewhere/Loose' }, 'Loose'],
  ] as const)('installs %s, asking nothing', async (_case, given, name) => {
    register();
    await install([given], { name });

    expect(installs()).toEqual([{ package: given, target: { kind: 'new', name }, fomod: NO_CHOICES }]);
    nothingAsked();
  });

  it('installs over the target mod named, as an upgrade', async () => {
    const mods = await mkdtemp(join(tmpdir(), 'modbench-upgrade-'));
    await manifestedIn(join(mods, 'Harder VATS'));
    register({}, {}, modFoldersIn(mods, 'Harder VATS'));
    const answered = await install([outsideInstallationFile], { target: 'Harder VATS' });

    expect(installs()).toEqual([{ package: outsideInstallationFile, target: { kind: 'upgrade', name: 'Harder VATS' }, fomod: NO_CHOICES }]);
    expect(answered).toMatchObject({ outcome: { landed: [{ name: 'Harder VATS' }] } });
    await rm(mods, { recursive: true });
  });

  it('installs over a target that would lose files when the options carry force', async () => {
    register();
    await install([outsideInstallationFile], { target: 'Harder VATS', force: true });

    expect(installs()).toEqual([{ package: outsideInstallationFile, target: { kind: 'upgrade', name: 'Harder VATS' }, fomod: NO_CHOICES }]);
  });

  const EXACTLY_ONE = new Refusal('An agent call to install carries exactly one of the name of a new mod and the target mod to upgrade.');
  const ONE_PACKAGE = new Refusal('An agent call to install carries one package: a downloaded file, an archive or a folder.');

  it.each<[string, AgentCall['argument'], object, Refusal]>([
    ['neither the name of a new mod nor a target', [outsideInstallationFile], {}, EXACTLY_ONE],
    ['both the name of a new mod and a target', [outsideInstallationFile], { name: 'Foo', target: 'Harder VATS' }, EXACTLY_ONE],
    ['no package', [], { name: 'Bar' }, ONE_PACKAGE],
    ['two packages', [outsideInstallationFile, { kind: 'folder', path: '/elsewhere/Loose' }], { name: 'Bar' }, ONE_PACKAGE],
    ['a mod', [{ kind: 'mod', name: 'Some Mod' }], { name: 'Bar' },
      new Refusal('An agent call to a downloadedFile or archive or folder gesture carries downloadedFile or archive or folders only, and this one carries a mod.')],
    ['both choices and Manual', [outsideInstallationFile], { name: 'Bar', manual: true, choices: [] }, new Refusal('An agent call to install carries choices or manual, not both.')],
  ])('refuses a call that carries %s, installing nothing', async (_case, argument, options, refusal) => {
    register();

    expect(await refusalOf(argument, options)).toEqual(refusal);
    expect(fake.calls).toEqual([]);
  });

  it.each<[string, object, InstanceAnswers, string, string]>([
    ['refused by install', { name: 'Bar' }, { refusals: refusing('install', 'folder taken') }, 'Failed to install "Bar".', 'folder taken'],
    ['that throws', { target: 'Harder VATS' }, { unreadReads: { modOrder: 'modlist.txt is locked' } }, 'Failed to install "Harder VATS".', 'modlist.txt is locked'],
  ])('answers an install %s as the failure the view reports, reporting nothing itself', async (_case, options, answers, refusal, detail) => {
    const reporter = recordingReporter();

    register(reportingTo(reporter), answers);
    const answered = await install([outsideInstallationFile], options);

    expect(answered).toEqual({ applied: false, refusal, detail });
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['as a plain copy, and why', { kind: 'plainCopy', why: 'its installer cannot be read: bad XML' } as const, [{
      message: '"Bar" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer\'s own steps did not run:',
      detail: 'its installer cannot be read: bad XML.', severity: 'warning',
    }]],
    ['by Manual', { kind: 'plainCopy', why: 'Manual was asked for' } as const, [{
      message: '"Bar" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer\'s own steps did not run:',
      detail: 'Manual was asked for.', severity: 'warning',
    }]],
    ['without files its archive lacks, and what else its installer said', { kind: 'installer', missing: ['gone.esp', 'gone'], notes: ['Installer failed'] } as const, [
      { message: '"Bar" lacks files its FOMOD names and its archive does not hold:', detail: 'gone.esp, gone', severity: 'warning' },
      { message: '"Bar": its FOMOD\'s installer says', detail: 'Installer failed', severity: 'warning' },
    ]],
  ])('answers a FOMOD that landed %s, each a partial failure the agent reads with its Output line', async (_, fomod, partial) => {
    const reporter = recordingReporter();

    register(reportingTo(reporter), { installed: { landed: true, fomod } });
    const answered = await install([outsideInstallationFile], { name: 'Bar' });

    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Bar', fomod }], refused: [] }, partial });
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['its choices', { choices: [{ step: 'Main', groups: [{ group: 'Pick', options: ['A'] }] }] },
      { kind: 'choices', steps: [{ step: 'Main', groups: [{ group: 'Pick', options: ['A'] }] }] }],
    ['Manual', { manual: true }, { kind: 'manual' }],
  ])('hands the install %s, for a FOMOD', async (_, options, answer) => {
    register();
    await install([outsideInstallationFile], { name: 'Bar', ...options });

    expect(installs()).toEqual([{ package: outsideInstallationFile, target: { kind: 'new', name: 'Bar' }, fomod: answer }]);
  });

  it('answers a new mod whose mod order line could not be written as a warning partial', async () => {
    register({}, { refusals: refusing('changeModOrder', 'locked') });
    const answered = await install([outsideInstallationFile], { name: 'Bar' });

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"Bar" was installed, but its modlist.txt line could not be written', detail: 'locked', severity: 'warning' }],
    });
  });

  it('answers a downloaded file it could not mark installed as a log partial, writing no line itself', async () => {
    const log = vi.fn();

    register({ downloadedFileInstallReporting: { reporter: recordingReporter(), log, progressViewId: 'modbench.downloads' } }, { refusals: refusing('markDownloadedFile', 'locked') });
    const answered = await install([{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"foo.7z" was installed, but its Downloads status could not be updated', detail: 'locked', severity: 'log' }],
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('an install ends on the Instance loader\'s read, with the Mods progress bar open throughout', () => {
  beforeEach(() => { progressSteps.length = 0; });

  it('opens the bar, installs, reads, then closes the bar', async () => {
    showQuickPick.mockResolvedValueOnce({ packageKind: 'archive' });
    showOpenDialog.mockResolvedValueOnce([Uri.file('/somewhere/foo.zip')]);
    showInputBox.mockResolvedValueOnce('New Mod');

    register({
      instance: { value: instanceValueFixture(), ...instanceThatReads },
    }, { refusals: stepOnInstall });
    await invoke('modbench.mod.install');

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'install', 'Instance loader: read every file again', 'progress closes']);
  });
});
