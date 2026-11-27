import { join } from 'node:path';
import { createDownloadsView } from '../downloadsView';
import type { LocatedDownloadedFileRow, InstanceValue } from '../../instanceLoader/instance';
import { downloadedFileCommands } from '../../downloadedFileCommands/downloads';
import { commandInvoker, currentBoxOf } from '../../drivingLib/test/nameFilterViewHarness';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { recordingReporter } from '../../test/surfacingDoubles';
import { registered, treeViews } from './downloadsVscode';

type DownloadsViewDeps = Parameters<typeof createDownloadsView>[0];

export const DOWNLOADS_DIR = join('/instance', 'downloads');

/** An Instance value listing `rows` from the downloads folder the rows sit in. */
export const valueListing = (...rows: LocatedDownloadedFileRow[]): InstanceValue => instanceValueFixture({
  downloadedFiles: { kind: 'listed', rows },
  paths: { ...instanceValueFixture().paths, downloadsDir: DOWNLOADS_DIR },
});

export const instanceListing = (...rows: LocatedDownloadedFileRow[]): FakeInstance => new FakeInstance(valueListing(...rows));

/** The Downloads view the extension builds, over `instance`, with whatever of its other parts a test hands it. */
export const viewOver = (instance: FakeInstance, deps: Partial<Omit<DownloadsViewDeps, 'instance'>> = {}) => createDownloadsView({
  commands: downloadedFileCommands(fakeInstanceAdapter().adapter),
  queryInfo: () => Promise.resolve({ applied: true, outcome: { landed: [], refused: [] } }),
  download: { filesOf: () => Promise.resolve({ applied: true, files: [] }), download: () => Promise.resolve({ applied: false, refusal: 'not under test' }) },
  reporterFor: () => recordingReporter(),
  trash: () => Promise.resolve(),
  channel: { warn: () => undefined },
  ...deps,
  instance,
});

export const downloadsTree = () => treeViews.view('modbench.downloads');
export const command = commandInvoker(registered);
export const currentBox = currentBoxOf(registered);

const idOf = (row: unknown): unknown => (typeof row === 'object' && row !== null && 'id' in row ? row.id : undefined);

/** The rows VS Code draws in the Downloads view, as it asks its tree for them. */
export const rowsShown = async (): Promise<unknown[]> => (await downloadsTree().treeDataProvider.getChildren()) ?? [];

/** The names of the downloaded files the Downloads view shows, in its order. */
export const namesShown = async (): Promise<unknown[]> => (await rowsShown()).map(idOf);

/** The Downloads view's row of the downloaded file `name`, as VS Code hands it to a command. */
export const rowNamed = async (name: string): Promise<unknown> =>
  present((await rowsShown()).find((row) => idOf(row) === name), `the Downloads row of ${name}`);

/** Each of the Downloads view's rows, Show excluded turned on so that every downloaded file has one. */
export async function everyRow(instance: FakeInstance, deps: Parameters<typeof viewOver>[1] = {}) {
  const view = viewOver(instance, deps);
  await command('modbench.downloadedFile.showExcluded')();
  return view;
}
