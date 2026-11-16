import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the code; scripts/test-*.ts are manual scripts, not tests.
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Each test starts with fresh spies/mocks implementations.
    restoreMocks: true,
  },
});
