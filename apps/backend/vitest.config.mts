import { defineConfig } from 'vitest/config';

// Forks isolate each spec file in its own process, keeping peak memory
// flat as the suite grows. Globals stay on so specs keep bare
// describe/it/expect like before.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
  },
});
