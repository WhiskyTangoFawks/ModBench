import type { ReadModStatus } from '../client';

export const unreadStatus: ReadModStatus = () => Promise.reject(new Error('unscripted'));
