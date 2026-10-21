import type { HealthAnswer } from '../backendLifecycle';

export const answered = (up: boolean): HealthAnswer => up ? { healthy: true } : { healthy: false, reason: 'not up' };
