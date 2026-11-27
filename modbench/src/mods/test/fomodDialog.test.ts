import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import { AgentCall } from '../../drivingLib/agentGesture';
import { progressSteps } from '../../test/recordedProgress';
import { scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { settled } from '../../test/eventually';
import type { FomodDialog } from '../../modCommands/modCommands';
import { FOMOD_MOVE, FOMOD_READY, FOMOD_STATE, type FomodMove, type FomodState, type ReleaseImage } from '../../wire/fomodPage';

const STATE: FomodState<ReleaseImage> = { module: 'My Module', author: '', version: '', website: '', image: undefined, steps: [], current: 0 };
const SHOWN: FomodState = { ...STATE, image: '', steps: [] };
const RELEASE = '/staging/release';
const OPENS = 'progress opens on modbench.modList';
const CLOSES = 'progress closes';

type Shown = ReturnType<typeof modsViewOn>;

const installOnThePage = (view: Shown) =>
  view.run('modbench.mod.install', new AgentCall([{ kind: 'archive', path: '/elsewhere/bar.zip' }], { name: 'Bar', installer: true }));

const pagesHanded = ({ adapter }: Shown): FomodDialog[] =>
  adapter.calls.flatMap((call) => (call.verb === 'install' && call.fomod?.kind === 'dialog' ? [call.fomod.dialog] : []));

async function handedPage(ask: ScriptedDialog = scriptedDialog()): Promise<FomodDialog> {
  const view = modsViewOn({ ask });
  await installOnThePage(view);
  return present(pagesHanded(view)[0], 'the page the install was handed');
}

const tab = () => present(seen.panels[0], 'the installer\'s tab');

describe('the FOMOD installer\'s page, in a tab', () => {
  it('opens nothing until the installer has a state to show, then titles the tab by the module', async () => {
    const page = await handedPage();
    const before = seen.panels.length;

    page.show(STATE, RELEASE);

    expect([before, seen.panels.map(({ title }) => title)]).toEqual([0, ['FOMOD: My Module']]);
  });

  it('finds text in the page, as the record panel and the conflict table do (common.md, A view, story 12)', async () => {
    (await handedPage()).show(STATE, RELEASE);

    expect(tab().panelOptions).toMatchObject({ enableFindWidget: true });
  });

  it('lets the page load images from the release\'s folder and no other', async () => {
    (await handedPage()).show(STATE, RELEASE);

    expect(tab().webview.options).toMatchObject({ localResourceRoots: [{ fsPath: '/extension/out/webview' }, { fsPath: RELEASE }] });
  });

  it('sends each image of the state as a URI the page can load, and no URI for an image the state lacks', async () => {
    const page = await handedPage();
    const option = { id: 0, selected: false, name: 'A', description: '', type: 'Optional' as const };
    const step = (image: ReleaseImage) => ({
      id: 0, name: 'Main', visible: true,
      optionalFileGroups: { group: [{ id: 0, name: 'Pick', type: 'SelectAny' as const, options: [{ ...option, image }] }] },
    });
    page.show({ ...STATE, image: { path: 'Images/Header.png' }, steps: [step({ path: 'img/a.png' }), step(undefined)] }, RELEASE);

    tab().receive({ type: FOMOD_READY });

    const posted = JSON.stringify(tab().posted.at(-1));
    expect([...posted.matchAll(/"image":"([^"]*)"/g)].map(([, uri]) => uri)).toEqual([
      'webview:file:///staging/release/Images/Header.png', 'webview:file:///staging/release/img/a.png', '',
    ]);
  });

  it('sends the latest state once the page says it is ready, and each state after that as it comes', async () => {
    const page = await handedPage();
    page.show(STATE, RELEASE);

    tab().receive({ type: FOMOD_READY });
    page.show({ ...STATE, current: 1 }, RELEASE);

    expect(tab().posted).toEqual([
      { type: FOMOD_STATE, state: SHOWN }, { type: FOMOD_STATE, state: SHOWN }, { type: FOMOD_STATE, state: { ...SHOWN, current: 1 } },
    ]);
  });

  it('hands on the moves the page sends, and nothing else it says', async () => {
    const moves: FomodMove[] = [];
    const page = await handedPage();
    page.onMove((move) => moves.push(move));
    page.show(STATE, RELEASE);

    tab().receive({ type: FOMOD_MOVE, move: { kind: 'manual' } });
    tab().receive({ type: 'other' });

    expect(moves).toEqual([{ kind: 'manual' }]);
  });

  it('takes closing the tab as Cancel, but not the close the installer asks for itself', async () => {
    const moves: FomodMove[] = [];
    const view = modsViewOn();
    await installOnThePage(view);
    await installOnThePage(view);
    const [closedByUser, closedByInstaller] = pagesHanded(view);
    const shown = (page: FomodDialog | undefined): FomodDialog => {
      const handed = present(page, 'a page the install was handed');
      handed.onMove((move) => moves.push(move));
      handed.show(STATE, RELEASE);
      return handed;
    };
    shown(closedByUser);
    const byInstaller = shown(closedByInstaller);

    tab().dispose();
    const afterTheUser = [...moves];
    byInstaller.close();

    expect([afterTheUser, moves, seen.panels.map(({ disposed }) => disposed)]).toEqual([[{ kind: 'cancel' }], [{ kind: 'cancel' }], [true, true]]);
  });

  it('names the missing files in a modal confirmation, and installs without them only on Install anyway', async () => {
    const ask = scriptedDialog('Install anyway', undefined);
    const page = await handedPage(ask);

    expect([await page.confirmMissing(['a.esp', 'b/c.esp']), await page.confirmMissing(['a.esp'])]).toEqual([true, false]);
    expect(ask.asked[0]).toEqual({ message: 'This FOMOD names files its archive does not hold.', detail: 'a.esp\nb/c.esp', buttons: ['Install anyway'] });
  });

  it('refuses the installer in a modal that names why, and takes Manual only on Manual', async () => {
    const ask = scriptedDialog('Manual', undefined);
    const page = await handedPage(ask);

    expect([await page.refuse('its installer is a script'), await page.refuse('its installer is a script')]).toEqual(['manual', 'cancelled']);
    expect(ask.asked[0]).toEqual({ message: 'This FOMOD\'s installer cannot run.', detail: 'its installer is a script', buttons: ['Manual'] });
  });

  it('closes the view\'s progress while the user is asked, and shows it again after', async () => {
    const instance = new FakeInstance(instanceValueFixture());
    let read = (): void => undefined;
    vi.spyOn(instance, 'refresh').mockReturnValueOnce(new Promise<void>((resolve) => { read = resolve; }));
    const view = modsViewOn({ instance });
    const installing = installOnThePage(view);
    await settled(() => { expect(pagesHanded(view)).toHaveLength(1); });
    const page = present(pagesHanded(view)[0], 'the page the install was handed');

    page.asking(true);
    await settled(() => { expect(progressSteps).toEqual([OPENS, CLOSES]); });
    page.asking(false);
    const answered = [...progressSteps];
    read();
    await installing;

    expect(answered).toEqual([OPENS, CLOSES, OPENS]);
  });
});
