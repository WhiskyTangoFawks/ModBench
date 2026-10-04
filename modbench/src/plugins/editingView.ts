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
  log: { info(message: string): void; error(message: string): void };
  revealLog: () => void;
}

export function editingView(deps: EditingViewDeps) {
  const { narrator, progress, reportPut, reportEntry, log, revealLog } = deps;

  const around = (entry: () => Promise<void>): Promise<void> => progress.while(async () => {
    revealLog();
    progress.say('Starting backend…');
    log.info('[toolbox] entering editing: starting backend');
    await entry();
  });

  const tell = async (told: Told): Promise<void> => {
    switch (told.kind) {
      case 'abandoned':
        log.info('[toolbox] the reconcile was abandoned before it landed; leaving the closed view alone');
        return;
      case 'backendFailed':
        reportEntry('Backend failed to start — see the Modbench output for details.');
        return;
      case 'putThrew':
        log.error(`[loadOrder] handing mEdit the load order threw: ${told.message}`);
        return;
      case 'put':
        await tellPut(told.put);
    }
  };

  // A game folder not found, or one whose plugins cannot be listed, is told by the views and the
  // Output already; a line per value would repeat it.
  const tellPut = async (put: PutLoadOrderResult): Promise<void> => {
    if (!put.sent) return;
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
