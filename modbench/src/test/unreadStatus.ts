import type { ReadStatus } from '../modOrderCommands/install';

export const unreadStatus: ReadStatus = () => Promise.reject(new Error('unscripted'));
