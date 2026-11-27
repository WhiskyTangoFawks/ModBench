import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import type * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { Uri } from '../../test/vscodeMock';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { downloadedFilesOf, fakeInstanceAdapter, modFoldersOf, readingFixture, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { present } from '../../ports/present';
import { progressSteps } from '../../test/recordedProgress';
import { mod } from './indexedValue';

const installing = (answered: InstanceAnswers = {}) => modsViewOn({
  value: instanceValueFixture({ mods: [mod('Harder VATS')], downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('foo.7z')] } }),
  adapter: fakeInstanceAdapter(readingFixture({ modFolders: modFoldersOf('Harder VATS'), downloadedFiles: downloadedFilesOf('foo.7z') }), answered),
});

type View = ReturnType<typeof installing>;

const installs = ({ adapter }: View) => adapter.calls.flatMap((call) => (call.verb === 'install' ? [{ package: call.package, target: call.target, fomod: call.fomod }] : []));

const PICKED = { archive: 'Archive…', folder: 'Folder…' } as const;

function answering(packageKind: keyof typeof PICKED | undefined, picked?: string, name?: string): vscode.OpenDialogOptions[] {
  const opened: vscode.OpenDialogOptions[] = [];
  answers.quickPick = (items) => items.find(({ label }) => label === (packageKind && PICKED[packageKind]));
  answers.openDialog = (options) => { opened.push(options); return picked === undefined ? undefined : [Uri.file(picked)]; };
  answers.inputBox = () => name;
  return opened;
}

const ON_THE_PAGE = { kind: 'dialog', dialog: expect.anything() as unknown, steps: [] };

const NEW_MOD = { kind: 'new', name: 'New Mod' } as const;

const stepOnInstall: InstanceAnswers['refusals'] = (call) => {
  if (call.verb === 'install') progressSteps.push('install');
  return undefined;
};

describe('modbench.mod.install: installation file or folder, asked first', () => {
  it.each<[string, keyof typeof PICKED | undefined, string | undefined]>([
    ['Esc at the installation-file-or-folder pick', undefined, undefined],
    ['Esc at the OS picker for an installation file', 'archive', undefined],
    ['Esc at the OS picker for a folder', 'folder', undefined],
    ['a cancelled name prompt', 'archive', '/archive/foo.7z'],
  ])('%s installs nothing', async (_case, pick, picked) => {
    const view = installing();
    answering(pick, picked);

    await view.run('modbench.mod.install');

    expect(view.adapter.calls).toEqual([]);
  });

  it('asks installation file or folder before either OS picker opens', async () => {
    const view = installing();
    const asked: string[] = [];
    answers.quickPick = (items) => { asked.push('pick'); return items[0]; };
    answers.openDialog = () => { asked.push('OS picker'); return undefined; };

    await view.run('modbench.mod.install');

    expect(seen.quickPicks.map(({ labels }) => labels)).toEqual([['Archive…', 'Folder…']]);
    expect(asked).toEqual(['pick', 'OS picker']);
  });

  it.each([
    ['installation file', 'archive', '/archive/foo.7z', { filters: { 'Mod archives': ['zip', '7z', 'rar'] } }],
    ['folder', 'folder', '/somewhere/Loose Files', { canSelectFiles: false, canSelectFolders: true, canSelectMany: false }],
  ] as const)('%s: the OS picker offers what install takes, and installs the pick as a new mod under the name prompted', async (_case, packageKind, path, dialog) => {
    const view = installing();
    const opened = answering(packageKind, path, 'New Mod');

    await view.run('modbench.mod.install');

    expect(opened).toEqual([expect.objectContaining(dialog)]);
    expect(installs(view)).toEqual([{ package: { kind: packageKind, path }, target: NEW_MOD, fomod: ON_THE_PAGE }]);
  });
});

describe('modbench.mod.install: the name prompt', () => {
  it.each([
    ['archive', 'C:\\archive\\Sleep or Save.ZIP', 'Sleep or Save'],
    ['archive', '/archive/Mod v1.2.rar', 'Mod v1.2'],
    ['folder', '/somewhere/Loose Files', 'Loose Files'],
    ['folder', 'C:\\somewhere\\Loose v1.2', 'Loose v1.2'],
  ] as const)('%s picked at %s: the prompt holds %s', async (packageKind, picked, name) => {
    const view = installing();
    answering(packageKind, picked);

    await view.run('modbench.mod.install');

    expect(seen.inputBoxes).toEqual([expect.objectContaining({ prompt: 'Mod name', value: name })]);
  });

  it.each<[string, InstanceAnswers, string, string | undefined]>([
    ['the command\'s refusal of a name a folder holds', {}, 'harder vats',
      'A mod named "harder vats" already exists. Install its next release from Downloads, or uninstall it to install anew.'],
    ['nothing for a free name', {}, 'Free Name', undefined],
    ['why the command could not tell', { unreadReads: { modOrder: 'modlist.txt is locked' } }, 'Free Name', 'modlist.txt is locked'],
  ])('shows %s', async (_case, answered, typed, shown) => {
    const view = installing(answered);
    answering('folder', '/somewhere/Loose Files');

    await view.run('modbench.mod.install');
    const prompt = present(seen.inputBoxes[0], 'the name prompt');

    expect(await prompt.validateInput?.(typed)).toBe(shown);
  });
});

describe('modbench.mod.install from the view: what reaches the user', () => {
  it('reports nothing for an install the user cancelled on the FOMOD installer\'s page', async () => {
    const view = installing({ installed: { landed: false, cancelled: true } });
    answering('folder', '/somewhere/foo', 'New Mod');

    await view.run('modbench.mod.install');

    expect(view.reporter.reports).toEqual([]);
  });

  it('warns of what a FOMOD installed from the page said, and not of the missing files the user confirmed', async () => {
    const view = installing({ installed: { landed: true, fomod: { kind: 'installer', missing: ['gone.esp'], notes: ['Installer failed'] } } });
    answering('folder', '/somewhere/foo', 'New Mod');

    await view.run('modbench.mod.install');

    expect(view.reporter.reports).toEqual([{ severity: 'warning', message: '"New Mod": its FOMOD\'s installer says', detail: 'Installer failed' }]);
  });
});

describe('modbench.mod.install: a failed install', () => {
  it.each([
    ['archive', '/somewhere/foo.zip', 'installFromInstallationFile'],
    ['folder', '/somewhere/foo', 'installFromFolder'],
  ] as const)('from a %s is reported under the gesture, naming the mod', async (packageKind, picked, tag) => {
    const view = installing({ refusals: refusing('install', 'disk full') });
    answering(packageKind, picked, 'New Mod');
    const built = view.tags.length;

    await view.run('modbench.mod.install');

    expect(view.tags.slice(built)).toEqual([tag]);
    expect(view.reporter.reports).toEqual([{ severity: 'error', message: 'Failed to install "New Mod".', detail: 'disk full' }]);
  });
});

describe('modbench.mod.install: a downloaded file is its package', () => {
  it('a mod row as Argument is no package, so it asks installation file or folder', async () => {
    const view = installing();

    await view.run('modbench.mod.install', await view.row('Harder VATS'));

    expect(seen.quickPicks).toHaveLength(1);
    expect(view.adapter.calls).toEqual([]);
  });
});

const NO_CHOICES = { kind: 'choices', steps: [], installAnyway: false };

describe('modbench.mod.install called by the agent', () => {
  const outsideInstallationFile = { kind: 'archive' as const, path: '/elsewhere/bar.zip' };
  const install = (view: View, argument: AgentCall['argument'], options: object) => view.run('modbench.mod.install', new AgentCall(argument, options));
  const refusalOf = (view: View, argument: AgentCall['argument'], options: object) => install(view, argument, options).then(() => undefined, (error: unknown) => error);
  const nothingAsked = () => {
    expect([seen.quickPicks, seen.inputBoxes]).toEqual([[], []]);
  };

  it('installs the downloaded file named as a new mod under the name given, asking nothing, and answers the mod written', async () => {
    const view = installing();

    const answered = await install(view, [{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(installs(view)).toEqual([{ package: { kind: 'archive', path: '/downloads/foo.7z' }, target: { kind: 'new', name: 'Foo' }, fomod: NO_CHOICES }]);
    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Foo' }], refused: [] }, partial: [] });
    expect(view.reporter.reports).toEqual([]);
    nothingAsked();
  });

  it.each([
    ['an installation file outside the downloads as an installation file', outsideInstallationFile, 'Bar'],
    ['a folder as a folder', { kind: 'folder', path: '/elsewhere/Loose' }, 'Loose'],
  ] as const)('installs %s, asking nothing', async (_case, given, name) => {
    const view = installing();

    await install(view, [given], { name });

    expect(installs(view)).toEqual([{ package: given, target: { kind: 'new', name }, fomod: NO_CHOICES }]);
    nothingAsked();
  });

  it('installs over the target mod named, as an upgrade', async () => {
    const view = installing();

    const answered = await install(view, [outsideInstallationFile], { target: 'Harder VATS' });

    expect(installs(view)).toEqual([{ package: outsideInstallationFile, target: { kind: 'upgrade', name: 'Harder VATS' }, fomod: NO_CHOICES }]);
    expect(answered).toMatchObject({ outcome: { landed: [{ name: 'Harder VATS' }] } });
  });

  const EXACTLY_ONE = new Refusal('An agent call to install carries exactly one of the name of a new mod and the target mod to upgrade.');
  const MANUAL_ALONE = new Refusal('An agent call to install carries manual alone, without choices or installer.');
  const ONE_PACKAGE = new Refusal('An agent call to install carries one package: a downloaded file, an archive or a folder.');

  it.each<[string, AgentCall['argument'], object, Refusal]>([
    ['neither the name of a new mod nor a target', [outsideInstallationFile], {}, EXACTLY_ONE],
    ['both the name of a new mod and a target', [outsideInstallationFile], { name: 'Foo', target: 'Harder VATS' }, EXACTLY_ONE],
    ['no package', [], { name: 'Bar' }, ONE_PACKAGE],
    ['two packages', [outsideInstallationFile, { kind: 'folder', path: '/elsewhere/Loose' }], { name: 'Bar' }, ONE_PACKAGE],
    ['a mod', [{ kind: 'mod', name: 'Some Mod' }], { name: 'Bar' },
      new Refusal('An agent call to a downloadedFile or archive or folder gesture carries downloadedFile or archive or folders only, and this one carries a mod.')],
    ['both choices and Manual', [outsideInstallationFile], { name: 'Bar', manual: true, choices: [] }, MANUAL_ALONE],
    ['both the installer and Manual', [outsideInstallationFile], { name: 'Bar', manual: true, installer: true }, MANUAL_ALONE],
  ])('refuses a call that carries %s, installing nothing', async (_case, argument, options, refusal) => {
    const view = installing();

    expect(await refusalOf(view, argument, options)).toEqual(refusal);
    expect(view.adapter.calls).toEqual([]);
  });

  it.each<[string, InstanceAnswers, string, Refusal]>([
    ['the command\'s refusal of a name a folder holds', {}, 'harder vats',
      new Refusal('A mod named "harder vats" already exists. Install its next release from Downloads, or uninstall it to install anew.')],
    ['why the command could not tell', { unreadReads: { modOrder: 'modlist.txt is locked' } }, 'Bar', new Refusal('modlist.txt is locked')],
  ])('refuses a new mod\'s name with %s, installing nothing', async (_case, answered, name, refusal) => {
    const view = installing(answered);

    expect(await refusalOf(view, [outsideInstallationFile], { name })).toEqual(refusal);
    expect(view.adapter.calls).toEqual([]);
  });

  it.each<[string, object, InstanceAnswers, string, string]>([
    ['refused by install', { name: 'Bar' }, { refusals: refusing('install', 'folder taken') }, 'Failed to install "Bar".', 'folder taken'],
    ['that throws', { target: 'Harder VATS' }, { unreadReads: { modOrder: 'modlist.txt is locked' } }, 'Failed to install "Harder VATS".', 'modlist.txt is locked'],
  ])('answers an install %s as the failure the view reports, reporting nothing itself', async (_case, options, answered, refusal, detail) => {
    const view = installing(answered);

    const outcome = await install(view, [outsideInstallationFile], options);

    expect(outcome).toEqual({ applied: false, refusal, detail });
    expect(view.reporter.reports).toEqual([]);
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
    ['without the choices for steps the user did not reach on its page', { kind: 'installer', missing: [], notes: [], unused: ['Only for B', 'Extras'] } as const, [
      { message: '"Bar" was installed without the choices for steps the user did not reach:', detail: 'Only for B, Extras', severity: 'warning' },
    ]],
  ])('answers a FOMOD that landed %s, each a partial failure the agent reads with its Output line', async (_, fomod, partial) => {
    const view = installing({ installed: { landed: true, fomod } });

    const answered = await install(view, [outsideInstallationFile], { name: 'Bar' });

    expect(answered).toEqual({ applied: true, outcome: { landed: [{ name: 'Bar', fomod }], refused: [] }, partial });
    expect(view.reporter.reports).toEqual([]);
  });

  it.each([
    ['its choices', { choices: [{ step: 'Main', groups: [{ group: 'Pick', options: ['A'] }] }] },
      { kind: 'choices', steps: [{ step: 'Main', groups: [{ group: 'Pick', options: ['A'] }] }], installAnyway: false }],
    ['its choices, with install anyway', { installAnyway: true, choices: [] }, { kind: 'choices', steps: [], installAnyway: true }],
    ['Manual', { manual: true }, { kind: 'manual' }],
    ['the installer\'s page, opened on its choices', { installer: true, choices: [{ step: 'Main', groups: [] }] },
      { ...ON_THE_PAGE, steps: [{ step: 'Main', groups: [] }] }],
    ['the installer\'s page, on no choices', { installer: true }, ON_THE_PAGE],
  ])('hands the install %s, for a FOMOD', async (_, options, answer) => {
    const view = installing();

    await install(view, [outsideInstallationFile], { name: 'Bar', ...options });

    expect(installs(view)).toEqual([{ package: outsideInstallationFile, target: { kind: 'new', name: 'Bar' }, fomod: answer }]);
  });

  it('answers that the user cancelled the installer, reporting nothing', async () => {
    const view = installing({ installed: { landed: false, cancelled: true } });

    const answered = await install(view, [outsideInstallationFile], { name: 'Bar', installer: true });

    expect(answered).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'Bar' }, reason: 'The user cancelled the installer.' }] } });
    expect(view.reporter.reports).toEqual([]);
  });

  it('answers a new mod whose mod order line could not be written as a warning partial', async () => {
    const view = installing({ refusals: refusing('changeModOrder', 'locked') });

    const answered = await install(view, [outsideInstallationFile], { name: 'Bar' });

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"Bar" was installed, but its modlist.txt line could not be written', detail: 'locked', severity: 'warning' }],
    });
  });

  it('answers a downloaded file it could not mark installed as a log partial, writing no line itself', async () => {
    const view = installing({ refusals: refusing('markDownloadedFile', 'locked') });

    const answered = await install(view, [{ kind: 'downloadedFile', name: 'foo.7z' }], { name: 'Foo' });

    expect(answered).toMatchObject({
      applied: true,
      partial: [{ message: '"foo.7z" was installed, but its Downloads status could not be updated', detail: 'locked', severity: 'log' }],
    });
    expect(view.lines).toEqual([]);
  });
});

describe('an install ends on the Instance loader\'s read, with the Mods progress bar open throughout', () => {
  it('opens the bar, installs, reads, then closes the bar', async () => {
    const view = installing({ refusals: stepOnInstall });
    answering('archive', '/somewhere/foo.zip', 'New Mod');

    await view.run('modbench.mod.install');

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'install', 'progress closes']);
  });
});
