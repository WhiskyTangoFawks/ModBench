import { onTestFinished, vi } from 'vitest';
import { holdingTheWrite, surfaceRefusedWrites } from '../drivingLib/writingGesture';
import { recordingReporter, type RecordingReporter } from './surfacingDoubles';

/** A write that is in flight until the test ends, and the surface that tells the user of the writes it refuses. */
export function aWriteInFlight(): { readonly told: RecordingReporter; readonly redraw: ReturnType<typeof vi.fn<() => void>> } {
  const told = recordingReporter();
  const redraw = vi.fn<() => void>();
  const surface = surfaceRefusedWrites({ reporter: told, titles: new Map(), redraw });
  let ends!: () => void;
  const running = holdingTheWrite('modbench.test.held', () => new Promise<void>((resolve) => { ends = resolve; }));
  onTestFinished(async () => { ends(); await running; surface.dispose(); });
  return { told, redraw };
}
