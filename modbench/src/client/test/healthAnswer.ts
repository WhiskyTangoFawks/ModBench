import type { createMEditClient } from '..';

type HealthAnswer = Awaited<ReturnType<NonNullable<NonNullable<Parameters<typeof createMEditClient>[0]['backend']>['checkHealth']>>>;

export const answered = (up: boolean): HealthAnswer => up ? { healthy: true } : { healthy: false, reason: 'not up' };
