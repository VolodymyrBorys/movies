import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the code; scripts/test-*.ts are manual scripts, not tests.
    include: ["src/**/*.test.ts"],
    // Integration tests need real PG/Redis: vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, "src/**/*.int.test.ts"],
    environment: "node",
    // Each test starts with fresh spies/mocks implementations.
    restoreMocks: true,
  },
});
