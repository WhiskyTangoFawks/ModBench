import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// The tools: each a soak or a sweep, run at each release and never by the gates (spec/architecture/tests.md).
export default defineConfig({ ...base, test: { ...base.test, include: ['src/**/*.tool.ts'], silent: false } });
