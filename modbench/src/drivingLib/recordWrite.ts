import { runUnderProgress, type RecordWrite } from './writingGesture';
import type { Instance } from '../instanceLoader/instance';

export const recordWriteOver = (view: string, instance: Pick<Instance, 'refresh'>): RecordWrite =>
  (command) => runUnderProgress(view, instance, command);
