import { defineConfig } from "vitest/config";

// Integration tests: real PostgreSQL + Redis. Run with `npm run test:integration`.
// Requires an existing *_test database (see src/test/integration-env.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["src/test/integration-global-setup.ts"],
    setupFiles: ["src/test/integration-setup.ts"],
    // Files share one database and one Redis DB: run them one at a time.
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
