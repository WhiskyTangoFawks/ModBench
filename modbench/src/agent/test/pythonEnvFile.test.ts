import { describe, it, expect, vi } from 'vitest';

const read: { section: string; scope: unknown; key: string }[] = [];

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ path }) },
  workspace: {
    getConfiguration: (section: string, scope: unknown) => ({ get: (key: string) => { read.push({ section, scope, key }); return '/inst/.env'; } }),
  },
}));

import { scriptEnvironmentFileOf } from '../pythonEnvFile';

describe('the Python extension\'s envFile', () => {
  it('is read fresh in the scope of the instance folder', () => {
    expect([scriptEnvironmentFileOf('/inst')(), read.at(-1)]).toEqual(['/inst/.env', { section: 'python', scope: { path: '/inst' }, key: 'envFile' }]);
  });
});
