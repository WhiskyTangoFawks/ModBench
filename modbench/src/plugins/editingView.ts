import type { SyncFailureReport } from '../drivingLib/syncFailureReport';
import type { Told } from '../instanceCommands/editing';
import type { PutLoadOrderResult } from '../instanceCommands/loadOrder';

type AppliedStatus = Extract<Extract<PutLoadOrderResult, { sent: true }>['outcome'], { outcome: 'applied' }>['status'];

export interface EditingViewDeps {
  narrator: {
    hear(status: AppliedStatus): void;
    settled(version: number): Promise<void>;
  };
  progress: {
    while(work: () => Promise<void>): Promise<void>;
    say(message: string): void;
  };
  reportPut: (message: string) => void;
  reportEntry: (message: string) => void;
  reportExit: (message: string) => void;
  reportLaunch: (message: string, reason: string) => void;
  log: { info(message: string): void; error(message: string): void };
  revealLog: () => void;
  /** The load order the loader refused to build, the Plugins view's message line and the Output. */
  loadOrderPut: Pick<SyncFailureReport, 'run' | 'clear'>;
}

const STOPPED = 'mEdit stopped. Reload the window to start it again.';

export function editingView(deps: EditingViewDeps) {
  const { narrator, progress, reportPut, reportEntry, reportExit, reportLaunch, log, revealLog, loadOrderPut } = deps;

  const around = (entry: () => Promise<void>): Promise<void> => progress.while(async () => {
    revealLog();
    progress.say('Starting backend…');
    log.info('[toolbox] entering editing: starting backend');
    await entry();
  });

  const tell = async (told: Told): Promise<void> => {
    switch (told.kind) {
      case 'launchFailed':
        reportLaunch(STOPPED, told.reason);
        return;
      case 'backendFailed':
        reportEntry(STOPPED);
        return;
      case 'exited':
        reportExit(STOPPED);
        return;
      case 'put':
        await tellPut(told.put);
    }
  };

  // A game folder not found, or one whose plugins cannot be listed, is told by the views and the
  // Output already; a line per value would repeat it.
  const tellPut = async (put: PutLoadOrderResult): Promise<void> => {
    if (!put.sent) {
      const { refusal } = put;
      if (refusal !== undefined) await loadOrderPut.run(() => Promise.resolve({ applied: false as const, refusal }));
      return;
    }
    loadOrderPut.clear();
    const { plugins, active } = put.snapshot;
    log.info(`[toolbox] handed mEdit the load order snapshot (${plugins.length} plugins, ${active.length} active)`);
    const { outcome } = put;
    if (outcome.outcome === 'failed') reportPut(outcome.message);
    if (outcome.outcome !== 'applied') return;
    // The status the put waited for, heard here too: its ticks can be lost to a stream reopening.
    narrator.hear(outcome.status);
    await narrator.settled(outcome.status.version);
  };

  return { around, tell };
}
