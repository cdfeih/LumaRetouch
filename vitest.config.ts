import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native transport uses Node's test runner, executed separately.
    include: ['src/**/*.test.ts'],
  },
});
