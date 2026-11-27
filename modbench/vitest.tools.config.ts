import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// The tools (spec/architecture/tests.md).
export default defineConfig({ ...base, test: { ...base.test, include: ['src/**/*.tool.ts'], silent: false } });
