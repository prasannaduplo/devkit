import { defineConfig } from 'vitest/config';

// Unit tests for the framework-free model under src/app/model. Tests live in tests/ (outside src/) so the
// Angular build (tsconfig.app.json includes src/app/**) never compiles them.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
